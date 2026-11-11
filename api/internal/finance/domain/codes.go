package domain

import "github.com/syabanf/wit-hospitality/api/internal/billing"

// TransactionCode is how a folio line posts: a charge or rebate code names its revenue account.
// Billing owns the codes; finance copies each code that billing.transaction_code.saved.v1 carries.
type TransactionCode struct {
	ID         string  `json:"id"`
	Code       string  `json:"code"`
	Name       string  `json:"name"`
	Kind       string  `json:"kind"`
	Department string  `json:"department"`
	AccountID  *string `json:"accountId"`
	Active     bool    `json:"active"`
}

// Codes the folio relies on.
const (
	RoomCode  = "ROOM"
	OtherCode = "DMG"
)

// CategoryCode is CATEGORY_CODE, billing's published list: guest revenue categories book to their
// code's account.
var CategoryCode = billing.CategoryCode

// CodeAccount is codeAccount: an unknown or unmapped code falls to other income.
func CodeAccount(codes []TransactionCode, code string) string {
	for _, c := range codes {
		if c.Code == code {
			if c.AccountID != nil {
				return *c.AccountID
			}
			break
		}
	}
	return GLOtherIncome
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

// TaxSettings is billing's tax settings, copied by finance when billing.tax_settings.changed.v1 arrives.
type TaxSettings struct {
	Rates      []TaxRates        `json:"rates"`
	DirectMode string            `json:"directMode"`
	Regencies  map[string]string `json:"regencies"`
}
