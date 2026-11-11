package command

import (
	"context"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/finance"
	"github.com/syabanf/wit-hospitality/api/internal/finance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

// slug is the mock's slug().
func slug(text string) string {
	s := strings.Trim(slugRe.ReplaceAllString(strings.ToLower(text), "-"), "-")
	if s == "" {
		return "x"
	}
	return s
}

// SaveAccount is POST /cash-accounts and PATCH /cash-accounts/{id}.
type SaveAccount struct{ Deps }

// Handle needs master/create to open an account, master/edit to change one. A new account's
// opening balance books against owner equity, so its opening date must sit in an open month.
func (h SaveAccount) Handle(ctx context.Context, p auth.Principal, id string, in domain.CashAccountInput) (domain.CashAccount, error) {
	need := masterCreate
	if id != "" {
		need = masterEdit
	}
	if err := h.require(ctx, p, need); err != nil {
		return domain.CashAccount{}, err
	}
	var out domain.CashAccount
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.LockPeriods(ctx); err != nil {
			return err
		}
		accounts, err := h.Repo.Accounts(ctx)
		if err != nil {
			return err
		}
		if err := domain.ValidateAccount(in, accounts, id); err != nil {
			return err
		}
		by := Signer(p)
		if id != "" {
			before, err := h.Repo.Account(ctx, id, true)
			if err != nil {
				return err
			}
			out = in.Account(id)
			if err := h.Repo.SaveAccount(ctx, out); err != nil {
				return err
			}
			return h.record(ctx, by, audit.Line{Action: audit.Update, Entity: "cash-account", EntityID: id, Summary: "Edited " + out.Name, Before: before, After: out})
		}
		if in.OpeningBalance > 0 {
			if err := h.assertOpen(ctx, in.OpenedOn); err != nil {
				return err
			}
		}
		n, err := h.Repo.Next(ctx, "entity")
		if err != nil {
			return err
		}
		out = in.Account(fmt.Sprintf("acc-%s-%d", slug(in.Name), n))
		if err := h.Repo.SaveAccount(ctx, out); err != nil {
			return err
		}
		opening, err := domain.OpeningJournal(out)
		if err != nil {
			return err
		}
		if _, err := h.writeJournal(ctx, opening, by); err != nil {
			return err
		}
		return h.record(ctx, by, audit.Line{Action: audit.Create, Entity: "cash-account", EntityID: out.ID, Summary: "Opened " + out.Name})
	})
	return out, err
}

// SaveCategory is POST /categories and PATCH /categories/{id}; a PATCH with only active
// archives or restores the category.
type SaveCategory struct{ Deps }

// Handle needs master/create to add and master/edit to change. System categories keep their
// name and kind and stay active.
func (h SaveCategory) Handle(ctx context.Context, p auth.Principal, id string, in domain.CategoryInput) (domain.Category, error) {
	need := masterCreate
	if id != "" {
		need = masterEdit
	}
	if err := h.require(ctx, p, need); err != nil {
		return domain.Category{}, err
	}
	var out domain.Category
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		by := Signer(p)
		if id != "" && in.Active != nil && in.Name == nil {
			c, err := h.Repo.Category(ctx, id)
			if err != nil {
				return err
			}
			if !*in.Active && domain.IsSystemCategory(id) {
				return errs.Newf("CATEGORY_SYSTEM", "%s is a system category and stays active.", c.Name)
			}
			c.Active = *in.Active
			out = c
			if err := h.Repo.SaveCategory(ctx, c); err != nil {
				return err
			}
			verb := "Archived"
			if c.Active {
				verb = "Restored"
			}
			return h.record(ctx, by, audit.Line{Action: audit.Update, Entity: "category", EntityID: id, Summary: fmt.Sprintf("%s category %s", verb, c.Name)})
		}
		name := strings.TrimSpace(deref(in.Name))
		if runes(name) < 2 {
			return errs.Invalid("name", "Enter the category name.")
		}
		kind := deref(in.Kind)
		if kind != domain.CashIn && kind != domain.CashOut {
			return errs.Invalid("kind", "Pick cash in or cash out.")
		}
		villas := in.VillaIDs
		if villas == nil {
			villas = []string{}
		}
		if id != "" {
			c, err := h.Repo.Category(ctx, id)
			if err != nil {
				return err
			}
			if domain.IsSystemCategory(id) && (name != c.Name || kind != c.Kind) {
				return errs.Newf("CATEGORY_SYSTEM", "%s is a system category; only its villas can change.", c.Name)
			}
			c.Name, c.Kind, c.VillaIDs = name, kind, villas
			out = c
			if err := h.Repo.SaveCategory(ctx, c); err != nil {
				return err
			}
			return h.record(ctx, by, audit.Line{Action: audit.Update, Entity: "category", EntityID: id, Summary: "Edited category " + c.Name})
		}
		existing, err := h.Repo.Categories(ctx)
		if err != nil {
			return err
		}
		if slices.ContainsFunc(existing, func(c domain.Category) bool { return strings.EqualFold(c.Name, name) && c.Kind == kind }) {
			return errs.Invalid("name", name+" already exists.")
		}
		n, err := h.Repo.Next(ctx, "category")
		if err != nil {
			return err
		}
		out = domain.Category{ID: fmt.Sprintf("cat-%d", n), Name: name, Kind: kind, Slot: 0, Active: true, VillaIDs: villas}
		if err := h.Repo.SaveCategory(ctx, out); err != nil {
			return err
		}
		return h.record(ctx, by, audit.Line{Action: audit.Create, Entity: "category", EntityID: out.ID, Summary: "Added category " + out.Name})
	})
	return out, err
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// SaveRule is POST /approval-rules and PATCH /approval-rules/{id}.
type SaveRule struct{ Deps }

// Handle needs approval/create to add and approval/edit to change.
func (h SaveRule) Handle(ctx context.Context, p auth.Principal, id string, in domain.ApprovalRuleInput) (domain.ApprovalRule, error) {
	need := approvalCreate
	if id != "" {
		need = approvalEdit
	}
	if err := h.require(ctx, p, need); err != nil {
		return domain.ApprovalRule{}, err
	}
	if err := domain.ValidateApprovalRule(in); err != nil {
		return domain.ApprovalRule{}, err
	}
	var out domain.ApprovalRule
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		by := Signer(p)
		if id != "" {
			before, err := h.Repo.Rule(ctx, id)
			if err != nil {
				return err
			}
			out = in.Rule(id)
			if err := h.Repo.SaveRule(ctx, out); err != nil {
				return err
			}
			return h.record(ctx, by, audit.Line{Action: audit.Update, Entity: "approval-rule", EntityID: id, Summary: "Edited approval rule " + out.Name, Before: before, After: out})
		}
		n, err := h.Repo.Next(ctx, "rule")
		if err != nil {
			return err
		}
		out = in.Rule(fmt.Sprintf("rule-%d", n))
		if err := h.Repo.SaveRule(ctx, out); err != nil {
			return err
		}
		return h.record(ctx, by, audit.Line{Action: audit.Create, Entity: "approval-rule", EntityID: out.ID, Summary: "Added approval rule " + out.Name})
	})
	return out, err
}

// DeleteRule is DELETE /approval-rules/{id}.
type DeleteRule struct{ Deps }

// Handle needs approval/edit.
func (h DeleteRule) Handle(ctx context.Context, p auth.Principal, id string) error {
	if err := h.require(ctx, p, approvalEdit); err != nil {
		return err
	}
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		r, err := h.Repo.Rule(ctx, id)
		if err != nil {
			return err
		}
		if err := h.Repo.DeleteRule(ctx, id); err != nil {
			return err
		}
		return h.record(ctx, Signer(p), audit.Line{Action: audit.Delete, Entity: "approval-rule", EntityID: id, Summary: "Removed approval rule " + r.Name})
	})
}

// SaveProofPolicy is PUT /settings/proof-policy.
type SaveProofPolicy struct{ Deps }

// Handle needs finance/edit.
func (h SaveProofPolicy) Handle(ctx context.Context, p auth.Principal, threshold float64) (domain.ProofPolicy, error) {
	if err := h.require(ctx, p, financeEdit); err != nil {
		return domain.ProofPolicy{}, err
	}
	if err := domain.ValidateProofPolicy(threshold); err != nil {
		return domain.ProofPolicy{}, err
	}
	out := domain.ProofPolicy{Threshold: int64(threshold)}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.LockSetting(ctx, KeyProof, domain.DefaultProofPolicy); err != nil {
			return err
		}
		before, err := h.ProofPolicy(ctx)
		if err != nil {
			return err
		}
		if err := h.Repo.SaveSetting(ctx, KeyProof, out); err != nil {
			return err
		}
		return h.record(ctx, Signer(p), audit.Line{Action: audit.Update, Entity: "settings", EntityID: "proof-policy", Summary: "Changed the receipt rule for cash-outs", Before: before, After: out})
	})
	return out, err
}

// MapCategory is PUT /ledger/category-accounts/{categoryId}.
type MapCategory struct{ Deps }

// Handle needs finance/edit; the mapping applies to postings from then on.
func (h MapCategory) Handle(ctx context.Context, p auth.Principal, categoryID, accountID string) (map[string]string, error) {
	if err := h.require(ctx, p, financeEdit); err != nil {
		return nil, err
	}
	var out map[string]string
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		c, err := h.Repo.Category(ctx, categoryID)
		if err != nil {
			return err
		}
		accounts, err := h.Repo.Accounts(ctx)
		if err != nil {
			return err
		}
		chart := domain.ChartOfAccounts(accounts)
		if err := domain.ValidateMapping(accountID, chart, categoryID); err != nil {
			return err
		}
		if err := h.Repo.LockSetting(ctx, KeyCategories, map[string]string{}); err != nil {
			return err
		}
		m, err := h.CategoryMap(ctx)
		if err != nil {
			return err
		}
		var before any
		if v, ok := m[categoryID]; ok {
			before = v
		}
		m[categoryID] = accountID
		if err := h.Repo.SaveSetting(ctx, KeyCategories, m); err != nil {
			return err
		}
		out = maps.Clone(m)
		name := ""
		for _, a := range chart {
			if a.ID == accountID {
				name = a.Name
			}
		}
		return h.record(ctx, Signer(p), audit.Line{Action: audit.Update, Entity: "category", EntityID: categoryID, Summary: fmt.Sprintf("%s now books to %s", c.Name, name),
			Before: map[string]any{"accountId": before}, After: map[string]any{"accountId": accountID}})
	})
	return out, err
}

// SaveCode is POST /ledger/transaction-codes, PUT and PATCH /ledger/transaction-codes/{id}.
type SaveCode struct{ Deps }

func (h SaveCode) revenueAccounts(ctx context.Context) ([]domain.GlAccount, error) {
	accounts, err := h.Repo.Accounts(ctx)
	if err != nil {
		return nil, err
	}
	var out []domain.GlAccount
	for _, a := range domain.ChartOfAccounts(accounts) {
		if a.Type == "revenue" {
			out = append(out, a)
		}
	}
	return out, nil
}

// Handle adds (id "") or changes a code; needs finance/edit.
func (h SaveCode) Handle(ctx context.Context, p auth.Principal, id string, in domain.TransactionCodeInput) (domain.TransactionCode, error) {
	if err := h.require(ctx, p, financeEdit); err != nil {
		return domain.TransactionCode{}, err
	}
	var out domain.TransactionCode
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.LockSetting(ctx, "codes", struct{}{}); err != nil {
			return err
		}
		codes, err := h.Repo.Codes(ctx)
		if err != nil {
			return err
		}
		revenue, err := h.revenueAccounts(ctx)
		if err != nil {
			return err
		}
		if err := domain.ValidateTransactionCode(in, codes, revenue, id); err != nil {
			return err
		}
		by := Signer(p)
		accountName := func(c domain.TransactionCode) string {
			for _, a := range revenue {
				if c.AccountID != nil && a.ID == *c.AccountID {
					return a.Name
				}
			}
			return ""
		}
		if id == "" {
			n, err := h.Repo.Next(ctx, "entity")
			if err != nil {
				return err
			}
			out = in.Fields(fmt.Sprintf("tc-%s-%d", strings.ToLower(strings.TrimSpace(in.Code)), n))
			if err := h.Repo.SaveCode(ctx, out); err != nil {
				return err
			}
			if err := h.record(ctx, by, audit.Line{Action: audit.Create, Entity: "transaction-code", EntityID: out.Code, Summary: fmt.Sprintf("Added transaction code %s, %s", out.Code, out.Name),
				After: map[string]any{"accountId": out.AccountID}}); err != nil {
				return err
			}
			return h.emit(ctx, finance.EventTransactionCodeSaved, "transaction_code", out.ID, 1, out)
		}
		c, err := h.Repo.Code(ctx, id)
		if err != nil {
			return err
		}
		fields := in.Fields(id)
		if fields.Code != c.Code && c.Kind == "payment" {
			return errs.Newf("CODE_IN_USE", "%s names a payment method; keep the code and rename it instead.", c.Code)
		}
		if !fields.Active && c.Active {
			if err := domain.AssertCanDeactivate(c); err != nil {
				return err
			}
		}
		before := map[string]any{"code": c.Code, "accountId": c.AccountID, "active": c.Active}
		out = fields
		if err := h.Repo.SaveCode(ctx, out); err != nil {
			return err
		}
		summary := "Edited transaction code " + out.Code
		if deref(c.AccountID) != deref(out.AccountID) {
			summary += fmt.Sprintf(": books to %s from now on", accountName(out))
		}
		if err := h.record(ctx, by, audit.Line{Action: audit.Update, Entity: "transaction-code", EntityID: out.Code, Summary: summary, Before: before,
			After: map[string]any{"code": out.Code, "accountId": out.AccountID, "active": out.Active}}); err != nil {
			return err
		}
		return h.emit(ctx, finance.EventTransactionCodeSaved, "transaction_code", out.ID, 1, out)
	})
	return out, err
}

// SetCodeActive is PATCH /ledger/transaction-codes/{id} with { active }.
type SetCodeActive struct{ Deps }

// Handle needs finance/edit; ROOM and the payment codes stay active.
func (h SetCodeActive) Handle(ctx context.Context, p auth.Principal, id string, active bool) (domain.TransactionCode, error) {
	if err := h.require(ctx, p, financeEdit); err != nil {
		return domain.TransactionCode{}, err
	}
	var out domain.TransactionCode
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		c, err := h.Repo.Code(ctx, id)
		if err != nil {
			return err
		}
		if !active {
			if err := domain.AssertCanDeactivate(c); err != nil {
				return err
			}
		}
		c.Active = active
		out = c
		if err := h.Repo.SaveCode(ctx, c); err != nil {
			return err
		}
		verb := "Deactivated"
		if active {
			verb = "Restored"
		}
		if err := h.record(ctx, Signer(p), audit.Line{Action: audit.Update, Entity: "transaction-code", EntityID: c.Code, Summary: fmt.Sprintf("%s transaction code %s", verb, c.Code),
			Before: map[string]any{"active": !active}, After: map[string]any{"active": active}}); err != nil {
			return err
		}
		return h.emit(ctx, finance.EventTransactionCodeSaved, "transaction_code", c.ID, 1, c)
	})
	return out, err
}

// SaveTax is PUT /ledger/tax-settings.
type SaveTax struct{ Deps }

// Handle needs finance/edit. New rates start today or later and in an open month; a posting
// already made keeps the rates it was made at.
func (h SaveTax) Handle(ctx context.Context, p auth.Principal, in domain.TaxSettingsInput) (domain.TaxSettings, error) {
	if err := h.require(ctx, p, financeEdit); err != nil {
		return domain.TaxSettings{}, err
	}
	var out domain.TaxSettings
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.LockPeriods(ctx); err != nil {
			return err
		}
		codes, err := h.Repo.Codes(ctx)
		if err != nil {
			return err
		}
		var charge []string
		for _, c := range codes {
			if c.Kind == "charge" {
				charge = append(charge, c.Code)
			}
		}
		if err := domain.ValidateTaxSettings(in, charge); err != nil {
			return err
		}
		if err := h.Repo.LockSetting(ctx, KeyTax, domain.TaxSettings{Rates: []domain.TaxRates{}, DirectMode: "net", Regencies: map[string]string{}}); err != nil {
			return err
		}
		cur, err := h.Tax(ctx)
		if err != nil {
			return err
		}
		now := domain.RatesOn(cur, in.Rates.EffectiveFrom)
		changed := now == nil || !domain.SameRates(*now, in.Rates)
		if changed && in.Rates.EffectiveFrom < h.today() {
			return errs.Newf("TAX_RATES_BACKDATED", "New rates start today or later; postings before %s keep the rates they were made at.", h.today())
		}
		if changed {
			if err := h.assertOpen(ctx, in.Rates.EffectiveFrom); err != nil {
				return err
			}
		}
		before := map[string]any{"directMode": cur.DirectMode, "rates": len(cur.Rates)}
		out = cur
		if changed {
			r := in.Rates
			r.ServiceCodes, r.PB1Codes = slices.Clone(r.ServiceCodes), slices.Clone(r.PB1Codes)
			out.Rates = domain.WithRates(cur, r)
		}
		out.DirectMode = in.DirectMode
		out.Regencies = map[string]string{}
		for k, v := range in.Regencies {
			out.Regencies[k] = strings.TrimSpace(v)
		}
		if err := h.Repo.SaveSetting(ctx, KeyTax, out); err != nil {
			return err
		}
		summary := "Saved tax settings"
		if changed {
			summary += fmt.Sprintf(": service %v%% and PB1 %v%% from %s", in.Rates.ServicePct, in.Rates.PB1Pct, in.Rates.EffectiveFrom)
		}
		summary += ", direct prices " + in.DirectMode
		if err := h.record(ctx, Signer(p), audit.Line{Action: audit.Update, Entity: "tax-settings", EntityID: "tax", Summary: summary, Before: before,
			After: map[string]any{"directMode": out.DirectMode, "rates": len(out.Rates)}}); err != nil {
			return err
		}
		return h.emit(ctx, finance.EventTaxSettingsSaved, "tax_settings", "tax", 1, out)
	})
	return out, err
}

// SaveBudget is PUT /budgets/{villaId}/{year}.
type SaveBudget struct{ Deps }

// Handle needs finance/edit and the villa in scope, refused with the mock's wording.
func (h SaveBudget) Handle(ctx context.Context, p auth.Principal, in domain.BudgetInput) (domain.Budget, error) {
	var out domain.Budget
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		sc, err := h.scope(ctx, p)
		if err != nil {
			return err
		}
		v, ok := sc.Places.Villa(in.VillaID)
		if !ok {
			return errs.NotFound("villa", in.VillaID)
		}
		edit, err := h.can(ctx, p.Role, "finance", "edit")
		if err != nil {
			return err
		}
		if !edit || !sc.AllowedVilla(v.ID, v.LocationID) {
			return errs.Forbidden(fmt.Sprintf("%s cannot edit the budget of %s.", rbac.RoleLabel[p.Role], v.Name))
		}
		if err := domain.ValidateBudget(in); err != nil {
			return err
		}
		out = domain.Budget{VillaID: in.VillaID, Year: in.Year, Months: slices.Clone(in.Months), UpdatedBy: p.Name, UpdatedOn: h.today()}
		replaced, err := h.Repo.SaveBudget(ctx, out)
		if err != nil {
			return err
		}
		action := audit.Create
		if replaced {
			action = audit.Update
		}
		return h.record(ctx, Signer(p), audit.Line{Action: action, Entity: "budget", EntityID: fmt.Sprintf("%s-%d", in.VillaID, int(in.Year)), Summary: fmt.Sprintf("Saved the %d budget of %s", int(in.Year), v.Name)})
	})
	return out, err
}
