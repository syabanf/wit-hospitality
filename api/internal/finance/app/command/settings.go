package command

import (
	"context"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"

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
