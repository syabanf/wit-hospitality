package command

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/finance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// NewManualJournal is POST /ledger/manual-journals: the form, the files by id or as records, and
// whether it goes straight for approval.
type NewManualJournal struct {
	domain.ManualJournalInput
	AttachmentIDs []string `json:"attachmentIds"`
	Submit        bool     `json:"submit"`
}

// CreateManualJournal writes a manual journal.
type CreateManualJournal struct{ Deps }

// Handle needs finance/submit to submit and finance/create to draft.
func (h CreateManualJournal) Handle(ctx context.Context, p auth.Principal, in NewManualJournal) (domain.ManualJournal, error) {
	need := financeCreate
	if in.Submit {
		need = financeSubmit
	}
	if err := h.require(ctx, p, need); err != nil {
		return domain.ManualJournal{}, err
	}
	var out domain.ManualJournal
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if in.VillaID != nil {
			sc, err := h.scope(ctx, p)
			if err != nil {
				return err
			}
			if !sc.VillaSeen(*in.VillaID) {
				return outside("journal")
			}
		}
		if in.Attachments == nil && len(in.AttachmentIDs) > 0 {
			files, err := h.Files.Attachments(ctx, in.AttachmentIDs)
			if err != nil {
				return err
			}
			in.Attachments = files
		}
		var err error
		out, err = h.newManualJournal(ctx, in.ManualJournalInput, in.Submit, Signer(p))
		return err
	})
	return out, err
}

// newManualJournal is the ledger's newManualJournal: drafted or submitted; it books when it posts.
func (d Deps) newManualJournal(ctx context.Context, in domain.ManualJournalInput, submit bool, by domain.Signer) (domain.ManualJournal, error) {
	accounts, err := d.Repo.Accounts(ctx)
	if err != nil {
		return domain.ManualJournal{}, err
	}
	if err := domain.ValidateManualJournal(in, domain.ChartOfAccounts(accounts)); err != nil {
		return domain.ManualJournal{}, err
	}
	var lines []domain.JournalLine
	for _, l := range in.Lines {
		if l.Debit > 0 || l.Credit > 0 {
			lines = append(lines, l)
		}
	}
	if err := domain.AssertBalanced(lines); err != nil {
		return domain.ManualJournal{}, err
	}
	n, err := d.Repo.Next(ctx, "manualJournal")
	if err != nil {
		return domain.ManualJournal{}, err
	}
	on := d.today()
	m := domain.ManualJournal{Date: in.Date, VillaID: in.VillaID, Memo: strings.TrimSpace(in.Memo), Lines: lines, Attachments: slices.Clone(in.Attachments),
		ID: fmt.Sprintf("mj-%d", n), Number: fmt.Sprintf("MJ-%04d", n), Status: domain.Draft, Approvals: []domain.ApprovalGrant{},
		History: []domain.TransactionEvent{domain.Event("created", by, on, "")}, CreatedBy: by.Name, CreatedByID: by.ID, CreatedOn: on}
	if m.Attachments == nil {
		m.Attachments = []domain.Attachment{}
	}
	verb := "Drafted"
	if submit {
		m.Status, verb = domain.Submitted, "Submitted"
		m.History = append(m.History, domain.Event("submitted", by, on, ""))
	}
	if err := d.Repo.SaveManualJournal(ctx, &m); err != nil {
		return m, err
	}
	return m, d.record(ctx, by, audit.Line{Action: audit.Create, Entity: "manual-journal", EntityID: m.Number, Summary: fmt.Sprintf("%s %s, %s", verb, m.Number, m.Memo),
		After: map[string]any{"amount": domain.TotalDebits(lines)}})
}

// TransitionManualJournal is POST /ledger/manual-journals/{id}/{action}.
type TransitionManualJournal struct{ Deps }

// Handle signs a journal like a cash-out of its total under the same rules, and posts it into an
// open month.
func (h TransitionManualJournal) Handle(ctx context.Context, p auth.Principal, id, to, note string) (domain.ManualJournal, error) {
	var need []rbac.Need
	switch to {
	case domain.Approved, domain.Rejected:
		need = approvalApprove
	case domain.Posted:
		need = financePost
	default:
		need = financeSubmit
	}
	if err := h.require(ctx, p, need); err != nil {
		return domain.ManualJournal{}, err
	}
	var out domain.ManualJournal
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.LockPeriods(ctx); err != nil {
			return err
		}
		m, err := h.Repo.ManualJournal(ctx, id)
		if err != nil {
			return err
		}
		if m.VillaID != nil {
			sc, err := h.scope(ctx, p)
			if err != nil {
				return err
			}
			if !sc.VillaSeen(*m.VillaID) {
				return outside("journal")
			}
		}
		if !domain.CanTransition(m.Status, to) {
			code := "TRANSACTION_INVALID_STATE"
			if m.Status == domain.Posted {
				code = "TRANSACTION_ALREADY_POSTED"
			}
			return errs.Newf(code, "A %s journal cannot become %s.", m.Status, to)
		}
		before := m.Status
		by, on := Signer(p), h.today()
		a := domain.Approvable{Number: m.Number, Status: &m.Status, Approvals: &m.Approvals, History: &m.History, RejectionReason: &m.RejectionReason, CreatedByID: m.CreatedByID, Noun: "journal"}
		switch to {
		case domain.Submitted:
			a.Submit(by, on, note)
		case domain.Approved:
			rules, err := h.Repo.Rules(ctx)
			if err != nil {
				return err
			}
			if err := a.Approve(domain.RequiredLevels(rules, domain.CashOut, m.Villa(), domain.TotalDebits(m.Lines)), by, on, note); err != nil {
				return err
			}
		case domain.Rejected:
			if err := a.Reject(by, on, note); err != nil {
				return err
			}
		case domain.Posted:
			if err := h.assertOpen(ctx, m.Date); err != nil {
				return err
			}
			draft, err := domain.ManualJournalEntry(m)
			if err != nil {
				return err
			}
			e, err := h.writeJournal(ctx, draft, by)
			if err != nil {
				return err
			}
			m.JournalID = &e.ID
			m.Status = domain.Posted
			m.History = append(m.History, domain.Event("posted", by, on, note))
		}
		if err := h.Repo.SaveManualJournal(ctx, &m); err != nil {
			return err
		}
		action, verb := audit.Status, strings.ToUpper(to[:1])+to[1:]
		switch to {
		case domain.Approved:
			action = audit.Approve
			if m.Status != domain.Approved {
				verb = "Signed"
			}
		case domain.Rejected:
			action = audit.Reject
		}
		out = m
		return h.record(ctx, by, audit.Line{Action: action, Entity: "manual-journal", EntityID: m.Number, Summary: fmt.Sprintf("%s %s, %s", verb, m.Number, m.Memo),
			Before: map[string]any{"status": before}, After: map[string]any{"status": m.Status}})
	})
	return out, err
}

// ClosePeriod is POST /ledger/periods/{month}/close.
type ClosePeriod struct{ Deps }

// Handle needs finance/post: the month has ended, is open, and nothing dated in it waits.
func (h ClosePeriod) Handle(ctx context.Context, p auth.Principal, month, note string) (domain.PeriodClose, error) {
	if err := h.require(ctx, p, financePost); err != nil {
		return domain.PeriodClose{}, err
	}
	var out domain.PeriodClose
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.LockPeriods(ctx); err != nil {
			return err
		}
		closed, err := h.Repo.ClosedMonths(ctx)
		if err != nil {
			return err
		}
		txs, err := h.Repo.Transactions(ctx)
		if err != nil {
			return err
		}
		manual, err := h.Repo.ManualJournals(ctx)
		if err != nil {
			return err
		}
		waiting := 0
		for _, t := range txs {
			if domain.AwaitsApproval(t.Status) && domain.MonthOf(t.Date) == month {
				waiting++
			}
		}
		for _, m := range manual {
			if domain.AwaitsApproval(m.Status) && domain.MonthOf(m.Date) == month {
				waiting++
			}
		}
		if err := domain.AssertClosable(month, h.today(), closed, waiting); err != nil {
			return err
		}
		out = domain.PeriodClose{Month: month, ClosedOn: h.today(), ClosedBy: p.Name, Note: strings.TrimSpace(note)}
		if err := h.Repo.InsertClose(ctx, out); err != nil {
			return err
		}
		return h.record(ctx, Signer(p), audit.Line{Action: audit.Status, Entity: "period", EntityID: month, Summary: "Closed the books for " + month,
			Before: map[string]any{"closed": false}, After: map[string]any{"closed": true}})
	})
	return out, err
}

// ReopenPeriod is POST /ledger/periods/{month}/reopen.
type ReopenPeriod struct{ Deps }

// Handle needs finance/post and a reason.
func (h ReopenPeriod) Handle(ctx context.Context, p auth.Principal, month, reason string) error {
	if err := h.require(ctx, p, financePost); err != nil {
		return err
	}
	reason = strings.TrimSpace(reason)
	if runes(reason) < 3 {
		return errs.Invalid("reason", "Say why the month reopens.")
	}
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.LockPeriods(ctx); err != nil {
			return err
		}
		closed, err := h.Repo.ClosedMonths(ctx)
		if err != nil {
			return err
		}
		if !slices.Contains(closed, month) {
			return errs.Newf("PERIOD_OPEN", "%s is not closed.", month)
		}
		if err := h.Repo.DeleteClose(ctx, month); err != nil {
			return err
		}
		return h.record(ctx, Signer(p), audit.Line{Action: audit.Status, Entity: "period", EntityID: month, Summary: fmt.Sprintf("Reopened the books for %s: %s", month, reason),
			Before: map[string]any{"closed": true}, After: map[string]any{"closed": false}})
	})
}
