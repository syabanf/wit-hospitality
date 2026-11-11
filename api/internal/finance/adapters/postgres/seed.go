package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/finance/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/finance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
)

// SeedData is seed/finance.json, written by scripts/export-seed.mjs from the mock's buildState:
// the cash ledger, the books exactly as buildJournals wrote them, the cashier shifts, and what the
// posting rules read from other contexts (stays, entry links, sources).
type SeedData struct {
	BaseDate         string                   `json:"baseDate"`
	CashAccounts     []domain.CashAccount     `json:"cashAccounts"`
	Categories       []domain.Category        `json:"categories"`
	Transactions     []domain.Transaction     `json:"transactions"`
	Reconciliations  []domain.Reconciliation  `json:"reconciliations"`
	ApprovalRules    []domain.ApprovalRule    `json:"approvalRules"`
	ProofPolicy      domain.ProofPolicy       `json:"proofPolicy"`
	CategoryAccounts map[string]string        `json:"categoryAccounts"`
	TransactionCodes []domain.TransactionCode `json:"transactionCodes"`
	Tax              domain.TaxSettings       `json:"tax"`
	Journals         []domain.JournalEntry    `json:"journals"`
	ManualJournals   []domain.ManualJournal   `json:"manualJournals"`
	PeriodCloses     []domain.PeriodClose     `json:"periodCloses"`
	Budgets          []domain.Budget          `json:"budgets"`
	PayrollCosts     []struct {
		Month   string `json:"month"`
		VillaID string `json:"villaId"`
		Amount  int64  `json:"amount"`
	} `json:"payrollCosts"`
	Refs []struct {
		Ref           string `json:"ref"`
		TransactionID string `json:"transactionId"`
	} `json:"refs"`
	Stays   []domain.Stay      `json:"stays"`
	Links   []domain.EntryLink `json:"links"`
	Sources []struct {
		TransactionID string `json:"transactionId"`
		Type          string `json:"type"`
		ID            string `json:"id"`
	} `json:"sources"`
	Next map[string]int64 `json:"next"`
}

var monthRef = regexp.MustCompile(`\d{4}-\d{2}`)

// shifter moves the fixture to today: dates by days, payroll months and their references by months.
type shifter struct{ clock.Shift }

func (s shifter) stamp(v string) string {
	if len(v) < 10 {
		return v
	}
	return s.Date(v[:10]) + v[10:]
}

func (s shifter) ref(v string) string {
	return monthRef.ReplaceAllStringFunc(v, s.Month)
}

func (s shifter) events(h []domain.TransactionEvent) {
	for i := range h {
		h[i].On = s.Date(h[i].On)
	}
}

func (s shifter) grants(g []domain.ApprovalGrant) {
	for i := range g {
		g[i].On = s.Date(g[i].On)
	}
}

func (s shifter) files(a []domain.Attachment) {
	for i := range a {
		a[i].UploadedAt = s.stamp(a[i].UploadedAt)
	}
}

func (s shifter) transaction(t *domain.Transaction) {
	t.Date, t.CreatedOn = s.Date(t.Date), s.Date(t.CreatedOn)
	if t.Origin == "payroll" {
		t.Reference = s.ref(t.Reference)
	}
	s.events(t.History)
	s.grants(t.Approvals)
	s.files(t.Attachments)
}

func (s shifter) journal(e *domain.JournalEntry) {
	e.Date, e.PostedOn = s.Date(e.Date), s.Date(e.PostedOn)
	switch e.Source {
	case domain.SourcePayroll:
		e.SourceID, e.SourceNumber = s.ref(e.SourceID), s.ref(e.SourceNumber)
		if m, j := monthRef.FindString(e.SourceNumber), strings.Index(e.Memo, ":"); m != "" && j > 0 {
			e.Memo = "Payroll " + domain.PeriodLabel(m) + e.Memo[j:]
		}
	case domain.SourceOpening:
		e.SourceID = "opening-" + e.Date
	}
}

// ParseSeed decodes the fixture.
func ParseSeed(raw []byte) (SeedData, error) {
	var s SeedData
	err := json.Unmarshal(raw, &s)
	return s, err
}

// Seed replaces the finance write model with the fixture moved to today. Its records need no
// events: no other context reads finance's tables, and the reads come from the write tables.
func Seed(ctx context.Context, d *db.DB, data SeedData, today string) error {
	s := shifter{clock.ShiftFor(data.BaseDate, today)}
	r := Repo{DB: d}
	return d.InTx(ctx, func(ctx context.Context) error {
		if _, err := d.Q(ctx).Exec(ctx, `TRUNCATE finance.counters, finance.cash_accounts, finance.categories, finance.transactions, finance.entry_links,
			finance.payroll_postings, finance.reconciliations, finance.approval_rules, finance.settings, finance.transaction_codes, finance.journals,
			finance.manual_journals, finance.period_closes, finance.budgets, finance.stays, finance.payroll_costs, finance.refs RESTART IDENTITY`); err != nil {
			return err
		}
		for _, a := range data.CashAccounts {
			a.OpenedOn = s.Date(a.OpenedOn)
			if err := r.SaveAccount(ctx, a); err != nil {
				return fmt.Errorf("seed account %s: %w", a.ID, err)
			}
		}
		for _, c := range data.Categories {
			if err := r.SaveCategory(ctx, c); err != nil {
				return err
			}
		}
		sources := map[string]*command.Source{}
		for _, x := range data.Sources {
			id := x.ID
			if x.Type == "payroll" {
				id = s.ref(id)
			}
			sources[x.TransactionID] = &command.Source{Type: x.Type, ID: id}
		}
		for _, t := range data.Transactions {
			s.transaction(&t)
			if err := r.InsertTransaction(ctx, &t, sources[t.ID]); err != nil {
				return fmt.Errorf("seed transaction %s: %w", t.ID, err)
			}
		}
		for _, l := range data.Links {
			if err := r.SaveLink(ctx, l); err != nil {
				return err
			}
		}
		for _, x := range data.Reconciliations {
			x.Date = s.Date(x.Date)
			if err := r.InsertReconciliation(ctx, x); err != nil {
				return err
			}
		}
		for _, x := range data.ApprovalRules {
			if err := r.SaveRule(ctx, x); err != nil {
				return err
			}
		}
		for _, c := range data.TransactionCodes {
			if err := r.SaveCode(ctx, c); err != nil {
				return err
			}
		}
		for key, v := range map[string]any{command.KeyProof: data.ProofPolicy, command.KeyTax: data.Tax, command.KeyCategories: data.CategoryAccounts} {
			if err := r.SaveSetting(ctx, key, v); err != nil {
				return err
			}
		}
		for _, e := range data.Journals {
			s.journal(&e)
			if err := r.InsertJournal(ctx, e); err != nil {
				return fmt.Errorf("seed journal %s: %w", e.ID, err)
			}
		}
		for _, m := range data.ManualJournals {
			m.Date, m.CreatedOn = s.Date(m.Date), s.Date(m.CreatedOn)
			s.events(m.History)
			s.grants(m.Approvals)
			if err := r.SaveManualJournal(ctx, &m); err != nil {
				return err
			}
		}
		for _, c := range data.PeriodCloses {
			c.Month, c.ClosedOn = s.Month(c.Month), s.Date(c.ClosedOn)
			if err := r.InsertClose(ctx, c); err != nil {
				return err
			}
		}
		for _, b := range data.Budgets {
			y, _ := strconv.Atoi(s.Month(fmt.Sprintf("%d-01", int(b.Year)))[:4])
			b.Year, b.UpdatedOn = float64(y), s.Date(b.UpdatedOn)
			if _, err := r.SaveBudget(ctx, b); err != nil {
				return err
			}
		}
		for _, c := range data.PayrollCosts {
			if err := r.SavePayrollCost(ctx, s.Month(c.Month), c.VillaID, c.Amount); err != nil {
				return err
			}
		}
		for _, x := range data.Refs {
			if err := r.SaveRef(ctx, x.Ref, command.RefTransaction, x.TransactionID); err != nil {
				return err
			}
		}
		for _, x := range data.Stays {
			x.BilledOn = s.DatePtr(x.BilledOn)
			if err := r.SaveStay(ctx, x); err != nil {
				return err
			}
		}
		for key, n := range data.Next {
			if _, err := d.Q(ctx).Exec(ctx, `INSERT INTO finance.counters (key, n) VALUES ($1, $2)`, key, n); err != nil {
				return err
			}
		}
		return nil
	})
}
