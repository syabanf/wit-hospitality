package command

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// SavePolicy saves the payment policy. It needs payments/edit.
type SavePolicy struct{ Deps }

// Handle saves the policy.
func (h SavePolicy) Handle(ctx context.Context, p auth.Principal, in domain.Policy) (domain.Policy, error) {
	if err := h.Authz.Require(ctx, p.Role, paymentsEdit...); err != nil {
		return in, err
	}
	if err := domain.ValidatePolicy(in); err != nil {
		return in, err
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		before, err := h.policy(ctx)
		if err != nil {
			return err
		}
		if err := h.Store.PutSetting(ctx, SettingPaymentPolicy, in); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "payment-policy", EntityID: "policy", Summary: "Changed the payment policy", Before: before, After: in})
	})
	return in, err
}

// SaveShiftPolicy saves the drawer tolerance. It needs finance/edit.
type SaveShiftPolicy struct{ Deps }

// Handle saves the shift policy.
func (h SaveShiftPolicy) Handle(ctx context.Context, p auth.Principal, in domain.ShiftPolicy) (domain.ShiftPolicy, error) {
	if err := h.Authz.Require(ctx, p.Role, financeEdit...); err != nil {
		return in, err
	}
	if err := domain.ValidateShiftPolicy(in); err != nil {
		return in, err
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		before, err := h.shiftPolicy(ctx)
		if err != nil {
			return err
		}
		if err := h.Store.PutSetting(ctx, SettingShiftPolicy, in); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "shift-policy", EntityID: "tolerance",
			Summary: "Shift tolerance set to " + domain.Money(int64(in.Tolerance)), Before: before, After: in})
	})
	return in, err
}

func (d Deps) chargeCodeNames(ctx context.Context) ([]string, error) {
	codes, err := d.codes(ctx)
	var out []string
	for _, c := range codes {
		if c.Kind == "charge" {
			out = append(out, c.Code)
		}
	}
	return out, err
}

// SaveTax adds rates from their effective date, never before today (TAX_RATES_BACKDATED), and
// publishes tax_settings.changed. It needs finance/edit.
type SaveTax struct{ Deps }

// Handle saves the tax settings.
func (h SaveTax) Handle(ctx context.Context, p auth.Principal, in domain.TaxSettingsInput) (domain.TaxSettings, error) {
	if err := h.Authz.Require(ctx, p.Role, financeEdit...); err != nil {
		return domain.TaxSettings{}, err
	}
	var out domain.TaxSettings
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		current, err := h.tax(ctx)
		if err != nil {
			return err
		}
		codes, err := h.chargeCodeNames(ctx)
		if err != nil {
			return err
		}
		next, added, err := domain.SaveTaxSettings(current, in, codes, h.today())
		if err != nil {
			return err
		}
		if added != nil {
			if err := h.Finance.AssertOpen(ctx, added.EffectiveFrom); err != nil {
				return err
			}
		}
		if err := h.Store.PutSetting(ctx, SettingTax, next); err != nil {
			return err
		}
		out = next
		if err := h.emit(ctx, billing.EventTaxSettingsChanged, "tax_settings", "tax", billing.TaxSettingsChanged{Where: billing.Where{Date: h.today()},
			Settings: mustJSON(next), ChangedRates: mustJSON(added), SavedBy: p.Name}); err != nil {
			return err
		}
		summary := "Saved tax settings"
		if added != nil {
			summary += fmt.Sprintf(": service %s%% and PB1 %s%% from %s", domain.Pct(added.ServicePct), domain.Pct(added.PB1Pct), added.EffectiveFrom)
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "tax-settings", EntityID: "tax", Summary: summary + ", direct prices " + next.DirectMode,
			Before: map[string]any{"directMode": current.DirectMode, "rates": len(current.Rates)}, After: map[string]any{"directMode": next.DirectMode, "rates": len(next.Rates)}})
	})
	return out, err
}

// accountNames are the BASE_CHART names of the revenue accounts a code books to.
var accountNames = map[string]string{"gl-4100": "Room revenue", "gl-4210": "Room service, food and drinks", "gl-4220": "Room service, minibar",
	"gl-4230": "Room service, laundry", "gl-4240": "Room service, transport", "gl-4250": "Room service, spa", "gl-4260": "Room service, tours",
	"gl-4270": "Room service, extras", "gl-4800": "Management fee income", "gl-4900": "Other income"}

// SaveCode adds or edits a transaction code; a change books from then on. It needs finance/edit.
type SaveCode struct{ Deps }

func (d Deps) saveCode(ctx context.Context, c domain.TransactionCode) error {
	if err := d.Store.Put(ctx, Codes, Row{ID: c.ID, Ref: c.Code, Doc: c}); err != nil {
		return err
	}
	return d.emit(ctx, billing.EventTransactionCodeSaved, "transaction_code", c.ID, billing.TransactionCodeSaved{Code: mustJSON(c)})
}

// ensureCodes stores the default codes the first time a code changes, so edits land on a full list.
func (d Deps) ensureCodes(ctx context.Context) ([]domain.TransactionCode, error) {
	rows, err := d.Store.All(ctx, Codes)
	if err != nil || len(rows) > 0 {
		return docs[domain.TransactionCode](rows, err)
	}
	codes := domain.DefaultTransactionCodes()
	for _, c := range codes {
		if err := d.Store.Put(ctx, Codes, Row{ID: c.ID, Ref: c.Code, Doc: c}); err != nil {
			return nil, err
		}
	}
	return codes, nil
}

// Create adds a code.
func (h SaveCode) Create(ctx context.Context, p auth.Principal, in domain.TransactionCodeInput) (domain.TransactionCode, error) {
	if err := h.Authz.Require(ctx, p.Role, financeEdit...); err != nil {
		return domain.TransactionCode{}, err
	}
	var out domain.TransactionCode
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		codes, err := h.ensureCodes(ctx)
		if err != nil {
			return err
		}
		if err := domain.ValidateTransactionCode(in, codes, domain.RevenueAccounts, ""); err != nil {
			return err
		}
		n, err := h.Store.Next(ctx, "entity")
		if err != nil {
			return err
		}
		f := domain.CleanCode(in)
		out = domain.TransactionCode{ID: fmt.Sprintf("tc-%s-%d", strings.ToLower(f.Code), n), Code: f.Code, Name: f.Name, Kind: f.Kind, Department: f.Department, AccountID: f.AccountID, Active: f.Active}
		if err := h.saveCode(ctx, out); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "transaction-code", EntityID: out.Code, Summary: fmt.Sprintf("Added transaction code %s, %s", out.Code, out.Name),
			After: map[string]any{"accountId": out.AccountID}})
	})
	return out, err
}

// Update edits a code: a payment code keeps its code, and ROOM and the payment codes stay active.
func (h SaveCode) Update(ctx context.Context, p auth.Principal, id string, in domain.TransactionCodeInput) (domain.TransactionCode, error) {
	if err := h.Authz.Require(ctx, p.Role, financeEdit...); err != nil {
		return domain.TransactionCode{}, err
	}
	var out domain.TransactionCode
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		codes, err := h.ensureCodes(ctx)
		if err != nil {
			return err
		}
		i := slices.IndexFunc(codes, func(c domain.TransactionCode) bool { return c.ID == id })
		if i < 0 {
			return errs.NotFound("transaction code", id)
		}
		code := codes[i]
		if err := domain.ValidateTransactionCode(in, codes, domain.RevenueAccounts, id); err != nil {
			return err
		}
		f := domain.CleanCode(in)
		if f.Code != code.Code && code.Kind == "payment" {
			return errs.Newf("CODE_IN_USE", "%s names a payment method; keep the code and rename it instead.", code.Code)
		}
		if !f.Active && code.Active {
			if err := domain.AssertCanDeactivate(code); err != nil {
				return err
			}
		}
		before := map[string]any{"code": code.Code, "accountId": code.AccountID, "active": code.Active}
		out = domain.TransactionCode{ID: code.ID, Code: f.Code, Name: f.Name, Kind: f.Kind, Department: f.Department, AccountID: f.AccountID, Active: f.Active}
		if err := h.saveCode(ctx, out); err != nil {
			return err
		}
		summary := "Edited transaction code " + out.Code
		if str(code.AccountID) != str(out.AccountID) {
			summary += ": books to " + accountNames[str(out.AccountID)] + " from now on"
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "transaction-code", EntityID: out.Code, Summary: summary, Before: before,
			After: map[string]any{"code": out.Code, "accountId": out.AccountID, "active": out.Active}})
	})
	return out, err
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// SetActive deactivates or restores a code.
func (h SaveCode) SetActive(ctx context.Context, p auth.Principal, id string, active bool) (domain.TransactionCode, error) {
	if err := h.Authz.Require(ctx, p.Role, financeEdit...); err != nil {
		return domain.TransactionCode{}, err
	}
	var out domain.TransactionCode
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		codes, err := h.ensureCodes(ctx)
		if err != nil {
			return err
		}
		i := slices.IndexFunc(codes, func(c domain.TransactionCode) bool { return c.ID == id })
		if i < 0 {
			return errs.NotFound("transaction code", id)
		}
		out = codes[i]
		if !active {
			if err := domain.AssertCanDeactivate(out); err != nil {
				return err
			}
		}
		out.Active = active
		if err := h.saveCode(ctx, out); err != nil {
			return err
		}
		verb := "Restored"
		if !active {
			verb = "Deactivated"
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "transaction-code", EntityID: out.Code, Summary: fmt.Sprintf("%s transaction code %s", verb, out.Code),
			Before: map[string]any{"active": !active}, After: map[string]any{"active": active}})
	})
	return out, err
}
