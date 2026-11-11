package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/owners"
	"github.com/syabanf/wit-hospitality/api/internal/owners/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// CloseInput is StatementClose. The API works the figures out itself from finance's villa
// results; Base, Stays and Entries, when the console sends them, must add up (STATEMENT_MISMATCH).
type CloseInput struct {
	ContractID string                  `json:"contractId"`
	Month      string                  `json:"month"`
	Base       *domain.StatementBase   `json:"base"`
	Stays      []domain.StatementStay  `json:"stays"`
	Entries    []domain.StatementEntry `json:"entries"`
	Note       string                  `json:"note"`
}

// CloseStatement closes a contract's month; it needs finance/post. Months close in order.
type CloseStatement struct{ Deps }

// Handle closes the statement and publishes it with its close journal.
func (h CloseStatement) Handle(ctx context.Context, p auth.Principal, in CloseInput) (domain.Statement, error) {
	if err := h.Authz.Require(ctx, p.Role, financePost...); err != nil {
		return domain.Statement{}, err
	}
	if err := assertOperator(p, "close statements"); err != nil {
		return domain.Statement{}, err
	}
	var st domain.Statement
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.Lock(ctx); err != nil {
			return err
		}
		c, err := h.Repo.Contract(ctx, in.ContractID)
		if err != nil {
			return err
		}
		villa, err := h.Repo.Villa(ctx, c.VillaID)
		if err != nil {
			return err
		}
		if err := inScope(p, villa); err != nil {
			return err
		}
		statements, err := h.Repo.Statements(ctx)
		if err != nil {
			return err
		}
		var d Draft
		if monthOK(in.Month) {
			if d, err = h.draft(ctx, c, in.Month, statements); err != nil {
				return err
			}
		}
		if err := domain.AssertClosable(c, in.Month, h.today(), statements, d.Pending); err != nil {
			return err
		}
		if in.Base != nil {
			if err := domain.AssertDrillDown(*in.Base, in.Stays, in.Entries); err != nil {
				return err
			}
		}
		n, err := h.Repo.Next(ctx, "statement")
		if err != nil {
			return err
		}
		st = domain.Statement{
			ID: fmt.Sprintf("os-%d", n), Number: domain.StatementNumber(in.Month, villa.Code), ContractID: c.ID, OwnerID: c.OwnerID, VillaID: c.VillaID,
			Month: in.Month, Figures: d.Figures, Stays: d.Stays, Entries: d.Entries, Status: domain.StatementClosed,
			BroughtFrom: d.Settlement.BroughtFrom, BroughtForward: d.Settlement.BroughtForward, Payable: d.Settlement.Payable, Shortfall: c.Shortfall,
			ClosedBy: p.Name, ClosedByID: p.UserID, ClosedOn: h.today(), Note: strings.TrimSpace(in.Note),
		}
		if err := h.Repo.InsertStatement(ctx, &st); err != nil {
			if _, dup := db.UniqueViolation(err); dup {
				return errs.Newf("STATEMENT_CLOSED", "The %s statement of %s is already closed.", in.Month, c.Number)
			}
			return err
		}
		f := d.Figures
		if err := h.record(ctx, p, audit.Line{Action: audit.Status, Entity: "owner-statement", EntityID: st.Number,
			Summary: fmt.Sprintf("Closed %s: net payable %d, %d after carry forward, management fee %d", st.Number, f.NetPayable, st.Payable, f.ManagementFee),
			After:   map[string]any{"netPayable": f.NetPayable, "broughtForward": st.BroughtForward, "payable": st.Payable, "managementFee": f.ManagementFee, "reserve": f.Reserve}}); err != nil {
			return err
		}
		return h.emit(ctx, owners.EventStatementClosed, "owner_statement", st.ID, st.Version, owners.StatementEvent{
			Statement: mustJSON(st), VillaID: villa.ID, LocationID: villa.LocationID, Journal: mustJSON(domain.CloseJournal(st)),
		})
	})
	return st, err
}

func monthOK(m string) bool { return len(m) == 7 && m[4] == '-' }

// ApproveStatement opens a closed statement to its owner; only the Owner (or an administrator)
// signs it, and never the person who closed it.
type ApproveStatement struct{ Deps }

// Handle approves the statement.
func (h ApproveStatement) Handle(ctx context.Context, p auth.Principal, id, note string) (domain.Statement, error) {
	if err := h.Authz.Require(ctx, p.Role, financeApprove...); err != nil {
		return domain.Statement{}, err
	}
	var st domain.Statement
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.Lock(ctx); err != nil {
			return err
		}
		var err error
		if st, err = h.Repo.Statement(ctx, id); err != nil {
			return err
		}
		villa, err := h.Repo.Villa(ctx, st.VillaID)
		if err != nil {
			return err
		}
		if err := inScope(p, villa); err != nil {
			return err
		}
		if st.Status != domain.StatementClosed {
			return errs.Newf("STATEMENT_INVALID_STATE", "%s is already approved.", st.Number)
		}
		if !domain.CanSignOwnerLevel(string(p.Role)) {
			return errs.Newf("APPROVAL_ROLE", "An owner statement needs the Owner’s approval; you are %s.", rbac.RoleLabel[p.Role])
		}
		if st.ClosedByID == p.UserID {
			return errs.New("APPROVAL_SELF", "The person who closed a statement cannot approve it.")
		}
		today := h.today()
		st.Status, st.ApprovedBy, st.ApprovedOn = domain.StatementApproved, &p.Name, &today
		if n := strings.TrimSpace(note); n != "" {
			if st.Note != "" {
				st.Note += " · " + n
			} else {
				st.Note = n
			}
		}
		if err := h.Repo.UpdateStatement(ctx, &st); err != nil {
			return err
		}
		if err := h.record(ctx, p, audit.Line{Action: audit.Approve, Entity: "owner-statement", EntityID: st.Number, Summary: "Approved " + st.Number,
			Before: map[string]any{"status": "closed"}, After: map[string]any{"status": "approved"}}); err != nil {
			return err
		}
		return h.emit(ctx, owners.EventStatementApproved, "owner_statement", st.ID, st.Version, owners.StatementEvent{Statement: mustJSON(st), VillaID: villa.ID, LocationID: villa.LocationID})
	})
	return st, err
}

// PayStatement asks finance for the payout of an approved statement, or the owner's top-up of a
// shortfall; it needs finance/post. Finance makes and submits the cash entry from the event.
type PayStatement struct{ Deps }

// Handle requests the payout.
func (h PayStatement) Handle(ctx context.Context, p auth.Principal, id, accountID string) (domain.Statement, error) {
	if err := h.Authz.Require(ctx, p.Role, financePost...); err != nil {
		return domain.Statement{}, err
	}
	if err := assertOperator(p, "pay statements"); err != nil {
		return domain.Statement{}, err
	}
	var st domain.Statement
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.Lock(ctx); err != nil {
			return err
		}
		var err error
		if st, err = h.Repo.Statement(ctx, id); err != nil {
			return err
		}
		villa, err := h.Repo.Villa(ctx, st.VillaID)
		if err != nil {
			return err
		}
		if err := inScope(p, villa); err != nil {
			return err
		}
		topUp, err := domain.AssertPayable(st)
		if err != nil {
			return err
		}
		if strings.TrimSpace(accountID) == "" {
			return errs.Invalid("accountId", "Owners are paid from a bank account.")
		}
		owner, err := h.Repo.Owner(ctx, st.OwnerID)
		if err != nil {
			return err
		}
		previous := ""
		if st.Payout != nil {
			previous = st.Payout.Label()
		}
		req := owners.PayoutRequested{
			SourceRef: ids.Random("osp"), StatementID: st.ID, StatementNumber: st.Number, AccountID: accountID, Date: h.today(),
			VillaID: villa.ID, LocationID: villa.LocationID, Reference: st.Number, Origin: "owner_payout",
			Kind: "cash_out", CategoryID: "cat-owner-payout", Amount: st.Payable,
			Description: fmt.Sprintf("Owner payout %s to %s, %s %s", st.Number, owner.Name, owner.Bank.Bank, owner.Bank.AccountNumber),
		}
		kind := "payout"
		if topUp {
			kind = "top-up"
			req.Kind, req.CategoryID, req.Amount = "cash_in", "cat-owner-topup", -st.Payable
			req.Description = fmt.Sprintf("Owner top-up %s from %s", st.Number, owner.Name)
		}
		st.Payout = &domain.Payout{Ref: req.SourceRef, Status: "submitted"}
		st.PayoutTransactionID = nil
		if err := h.Repo.UpdateStatement(ctx, &st); err != nil {
			return err
		}
		var before any
		if previous != "" {
			before = previous
		}
		if err := h.record(ctx, p, audit.Line{Action: audit.Status, Entity: "owner-statement", EntityID: st.Number,
			Summary: fmt.Sprintf("Submitted %s %s for %s", kind, req.SourceRef, st.Number),
			Before:  map[string]any{"payout": before}, After: map[string]any{"payout": req.SourceRef}}); err != nil {
			return err
		}
		return h.emit(ctx, owners.EventPayoutRequested, "owner_statement", st.ID, st.Version, req)
	})
	return st, err
}

// ReopenStatement takes the contract's latest unpaid statement back to open and reverses its close
// journal, so corrections flow into it; it needs finance/post.
type ReopenStatement struct{ Deps }

// Handle reopens the statement.
func (h ReopenStatement) Handle(ctx context.Context, p auth.Principal, id, reason string) (domain.Statement, error) {
	if err := h.Authz.Require(ctx, p.Role, financePost...); err != nil {
		return domain.Statement{}, err
	}
	if err := assertOperator(p, "reopen statements"); err != nil {
		return domain.Statement{}, err
	}
	var st domain.Statement
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.Lock(ctx); err != nil {
			return err
		}
		var err error
		if st, err = h.Repo.Statement(ctx, id); err != nil {
			return err
		}
		villa, err := h.Repo.Villa(ctx, st.VillaID)
		if err != nil {
			return err
		}
		if err := inScope(p, villa); err != nil {
			return err
		}
		statements, err := h.Repo.Statements(ctx)
		if err != nil {
			return err
		}
		if err := domain.AssertReopenable(st, statements, reason); err != nil {
			return err
		}
		why := strings.TrimSpace(reason)
		if err := h.Repo.DeleteStatement(ctx, st.ID); err != nil {
			return err
		}
		if err := h.record(ctx, p, audit.Line{Action: audit.Status, Entity: "owner-statement", EntityID: st.Number, Summary: fmt.Sprintf("Reopened %s: %s", st.Number, why),
			Before: map[string]any{"status": st.Status}, After: map[string]any{"status": "open"}}); err != nil {
			return err
		}
		return h.emit(ctx, owners.EventStatementReopened, "owner_statement", st.ID, st.Version+1, owners.StatementEvent{
			Statement: mustJSON(st), VillaID: villa.ID, LocationID: villa.LocationID, Journal: mustJSON(domain.ReopenJournal(st, why)), Reason: why,
		})
	})
	return st, err
}

// FollowFinance is owners' policy on finance.entry.approved, posted and rejected: the statement
// whose payout request carried the entry's sourceRef (or, for a seeded payout, whose payout is the
// transaction) records the cash entry and where it stands.
// Entries owners did not ask for are ignored, so a redelivery or another context's entry changes
// nothing.
type FollowFinance struct{ Deps }

// Handle applies one finance event inside the projector's transaction.
func (h FollowFinance) Handle(ctx context.Context, eventType string, e owners.FinanceEntry) error {
	status := map[string]string{owners.EventFinanceEntryApproved: "approved", owners.EventFinanceEntryPosted: "posted", owners.EventFinanceEntryRejected: "rejected"}[eventType]
	if (e.SourceRef == "" && e.TransactionID == "") || status == "" {
		return nil
	}
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		st, ok, err := h.Repo.StatementByPayout(ctx, e.SourceRef, e.TransactionID)
		if err != nil || !ok {
			return err
		}
		// A posted or rejected entry does not go back to approved on a late delivery.
		if st.Payout.Status == "posted" || (st.Payout.Status == "rejected" && status == "approved") {
			return nil
		}
		st.Payout.TransactionID, st.Payout.Number, st.Payout.Status = e.TransactionID, e.Number, status
		if e.TransactionID != "" {
			tid := e.TransactionID
			st.PayoutTransactionID = &tid
		}
		return h.Repo.UpdateStatement(ctx, &st)
	})
}
