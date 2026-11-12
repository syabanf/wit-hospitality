package domain

import (
	"math"
	"slices"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
)

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

// RatesOn is ratesOn: the rates a charge dated `date` uses; nil before the first rates start.
func (t TaxSettings) RatesOn(date string) *TaxRates {
	var found *TaxRates
	for i := range t.Rates {
		r := &t.Rates[i]
		if r.EffectiveFrom <= date && (found == nil || r.EffectiveFrom >= found.EffectiveFrom) {
			found = r
		}
	}
	return found
}

func roundHalfUp(v float64) int64 {
	if v < 0 {
		return -int64(math.Floor(-v + 0.5))
	}
	return int64(math.Floor(v + 0.5))
}

// InclusiveSplit is taxSplit in inclusive mode, as billing splits a room service code: the price
// is the gross, the net comes out of it and the rounding stays on PB1 (on service when the code
// carries no PB1), so the three add back to the price.
func InclusiveSplit(amount int64, code string, rates *TaxRates) TaxSplit {
	if rates == nil {
		return TaxSplit{Net: amount}
	}
	var service, pb1 float64
	if slices.Contains(rates.ServiceCodes, code) {
		service = rates.ServicePct
	}
	if slices.Contains(rates.PB1Codes, code) {
		pb1 = rates.PB1Pct
	}
	if service == 0 && pb1 == 0 {
		return TaxSplit{Net: amount}
	}
	onService := 1.0
	if rates.PB1OnService {
		onService = 1 + service/100
	}
	net := roundHalfUp(float64(amount) / (1 + service/100 + (pb1/100)*onService))
	s := amount - net
	if pb1 > 0 {
		s = roundHalfUp((float64(net) * service) / 100)
	}
	return TaxSplit{Net: net, Service: s, PB1: amount - net - s}
}
