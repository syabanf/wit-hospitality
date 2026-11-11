package domain

import (
	"regexp"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// TransactionCode is how a folio line posts: a charge or rebate code names its revenue account.
type TransactionCode struct {
	ID         string  `json:"id"`
	Code       string  `json:"code"`
	Name       string  `json:"name"`
	Kind       string  `json:"kind"`
	Department string  `json:"department"`
	AccountID  *string `json:"accountId"`
	Active     bool    `json:"active"`
}

// TransactionCodeInput is the code form.
type TransactionCodeInput struct {
	Code       string  `json:"code"`
	Name       string  `json:"name"`
	Kind       string  `json:"kind"`
	Department string  `json:"department"`
	AccountID  *string `json:"accountId"`
	Active     bool    `json:"active"`
}

var (
	codeKinds   = []string{"charge", "payment", "rebate"}
	departments = []string{"room", "fnb", "minibar", "laundry", "transport", "spa", "tours", "extras", "other", "taxes", "payment"}
	codeRe      = regexp.MustCompile(`^[A-Z][A-Z0-9]{1,7}$`)
)

// Codes the folio relies on.
const (
	RoomCode       = "ROOM"
	CityLedgerCode = "CL"
	OtherCode      = "DMG"
)

// CategoryCode is CATEGORY_CODE: guest revenue categories book to their code's account.
var CategoryCode = map[string]string{
	"cat-room": "ROOM", "cat-airbnb": "ROOM", "cat-extra": OtherCode, "cat-svc-fnb": "FNB", "cat-svc-laundry": "LDRY",
	"cat-svc-transport": "TRNS", "cat-svc-spa": "SPA", "cat-svc-tours": "TOUR", "cat-svc-other": "XTRA",
}

// CodeAccount is codeAccount: an unknown or unmapped code falls to other income.
func CodeAccount(codes []TransactionCode, code string) string {
	for _, c := range codes {
		if c.Code == code && c.AccountID != nil {
			return *c.AccountID
		}
		if c.Code == code {
			break
		}
	}
	return GLOtherIncome
}

// ValidateTransactionCode is validateTransactionCode; accounts are the revenue accounts.
func ValidateTransactionCode(in TransactionCodeInput, codes []TransactionCode, accounts []GlAccount, id string) error {
	var f errs.Fields
	code := strings.ToUpper(strings.TrimSpace(in.Code))
	if !codeRe.MatchString(code) {
		f.Add("code", "Two to eight letters or digits, starting with a letter.")
	} else if slices.ContainsFunc(codes, func(c TransactionCode) bool { return c.Code == code && c.ID != id }) {
		f.Add("code", code+" is taken.")
	}
	if runes(strings.TrimSpace(in.Name)) < 3 {
		f.Add("name", "Name the code.")
	}
	if !slices.Contains(codeKinds, in.Kind) {
		f.Add("kind", "Pick the kind.")
	}
	if !slices.Contains(departments, in.Department) {
		f.Add("department", "Pick the department.")
	}
	if in.Kind == "payment" && deref(in.AccountID) != "" {
		f.Add("accountId", "A payment code books by its cash entry; leave the account empty.")
	}
	if in.Kind != "payment" && !slices.ContainsFunc(accounts, func(a GlAccount) bool { return a.ID == deref(in.AccountID) }) {
		f.Add("accountId", "Pick the revenue account it books to.")
	}
	return f.Err()
}

// Fields is saveCode: the code upper case, the name trimmed, no account on a payment code.
func (in TransactionCodeInput) Fields(id string) TransactionCode {
	c := TransactionCode{ID: id, Code: strings.ToUpper(strings.TrimSpace(in.Code)), Name: strings.TrimSpace(in.Name), Kind: in.Kind, Department: in.Department, AccountID: in.AccountID, Active: in.Active}
	if in.Kind == "payment" {
		c.AccountID = nil
	}
	return c
}

// AssertCanDeactivate is assertCanDeactivate: ROOM and the payment codes stay active.
func AssertCanDeactivate(c TransactionCode) error {
	if c.Code == RoomCode || c.Kind == "payment" {
		what := "room night"
		if c.Kind == "payment" {
			what = "payment by that method"
		}
		return errs.Newf("CODE_IN_USE", "%s is used by every %s; it stays active.", c.Code, what)
	}
	return nil
}

// TaxRates is one version of the service and PB1 rates.
type TaxRates struct {
	EffectiveFrom string   `json:"effectiveFrom"`
	ServicePct    float64  `json:"servicePct"`
	PB1Pct        float64  `json:"pb1Pct"`
	PB1OnService  bool     `json:"pb1OnService"`
	ServiceCodes  []string `json:"serviceCodes"`
	PB1Codes      []string `json:"pb1Codes"`
}

// TaxSettings is the rates in force over time, the direct price mode and each location's regency.
type TaxSettings struct {
	Rates      []TaxRates        `json:"rates"`
	DirectMode string            `json:"directMode"`
	Regencies  map[string]string `json:"regencies"`
}

// TaxSettingsInput is the tax settings form.
type TaxSettingsInput struct {
	Rates      TaxRates          `json:"rates"`
	DirectMode string            `json:"directMode"`
	Regencies  map[string]string `json:"regencies"`
}

// RatesOn is ratesOn: the rates a posting dated date uses, nil before the first start.
func RatesOn(t TaxSettings, date string) *TaxRates {
	var found *TaxRates
	for i := range t.Rates {
		r := t.Rates[i]
		if r.EffectiveFrom <= date && (found == nil || r.EffectiveFrom >= found.EffectiveFrom) {
			found = &t.Rates[i]
		}
	}
	return found
}

// ValidateTaxSettings is validateTaxSettings; codes are the charge codes.
func ValidateTaxSettings(in TaxSettingsInput, codes []string) error {
	var f errs.Fields
	r := in.Rates
	if !IsDate(r.EffectiveFrom) {
		f.Add("effectiveFrom", "Pick the date the rates start.")
	}
	if !(r.ServicePct >= 0 && r.ServicePct <= 25) {
		f.Add("servicePct", "A percentage from 0 to 25.")
	}
	if !(r.PB1Pct >= 0 && r.PB1Pct <= 25) {
		f.Add("pb1Pct", "A percentage from 0 to 25.")
	}
	if slices.ContainsFunc(append(slices.Clone(r.ServiceCodes), r.PB1Codes...), func(c string) bool { return !slices.Contains(codes, c) }) {
		f.Add("codes", "Pick charge codes from the list.")
	}
	for _, v := range in.Regencies {
		if runes(strings.TrimSpace(v)) < 3 {
			f.Add("regencies", "Name the regency of every location.")
			break
		}
	}
	return f.Err()
}

// SameRates is sameRates: the same charges whatever their dates.
func SameRates(a, b TaxRates) bool {
	sorted := func(l []string) string {
		c := slices.Clone(l)
		slices.Sort(c)
		return strings.Join(c, ",")
	}
	return a.ServicePct == b.ServicePct && a.PB1Pct == b.PB1Pct && a.PB1OnService == b.PB1OnService && sorted(a.ServiceCodes) == sorted(b.ServiceCodes) && sorted(a.PB1Codes) == sorted(b.PB1Codes)
}

// WithRates is withRates: rates for a date replace any that start the same day.
func WithRates(t TaxSettings, rates TaxRates) []TaxRates {
	out := []TaxRates{}
	for _, r := range t.Rates {
		if r.EffectiveFrom != rates.EffectiveFrom {
			out = append(out, r)
		}
	}
	out = append(out, rates)
	slices.SortStableFunc(out, func(a, b TaxRates) int { return strings.Compare(a.EffectiveFrom, b.EffectiveFrom) })
	return out
}
