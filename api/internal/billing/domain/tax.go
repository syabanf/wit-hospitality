// Package domain holds the billing context's rules, ported from src/domain/folio.ts, tax.ts,
// transactionCode.ts, payment.ts, nightAudit.ts, cashier.ts, cityLedger.ts and the master folio of
// group.ts. Errors carry the TypeScript RuleError codes and wording. Nothing here reads a database.
package domain

import (
	"math"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Price modes.
const (
	ModeNet       = "net"
	ModeInclusive = "inclusive"
)

// The codes the folio puts service and PB1 on.
const (
	ServiceCode = "SVC"
	PB1Code     = "PB1"
)

// TaxRates is TaxRates: the rates from one effective date on.
type TaxRates struct {
	EffectiveFrom string   `json:"effectiveFrom"`
	ServicePct    float64  `json:"servicePct"`
	PB1Pct        float64  `json:"pb1Pct"`
	PB1OnService  bool     `json:"pb1OnService"`
	ServiceCodes  []string `json:"serviceCodes"`
	PB1Codes      []string `json:"pb1Codes"`
}

// TaxSettings is TaxSettings: the rates oldest first, the direct price mode and the PB1 regencies.
type TaxSettings struct {
	Rates      []TaxRates        `json:"rates"`
	DirectMode string            `json:"directMode"`
	Regencies  map[string]string `json:"regencies"`
}

// DefaultServiceCodes and DefaultPB1Codes are DEFAULT_SERVICE_CODES and DEFAULT_PB1_CODES.
var (
	DefaultServiceCodes = []string{"ROOM", "LATE", "FNB", "MINI", "SPA", "XTRA"}
	DefaultPB1Codes     = append(slices.Clone(DefaultServiceCodes), "LDRY")
)

// DefaultTaxRates is DEFAULT_TAX_RATES.
func DefaultTaxRates() TaxRates {
	return TaxRates{EffectiveFrom: "2020-01-01", ServicePct: 10, PB1Pct: 10, PB1OnService: true,
		ServiceCodes: slices.Clone(DefaultServiceCodes), PB1Codes: slices.Clone(DefaultPB1Codes)}
}

// DefaultTaxSettings is DEFAULT_TAX_SETTINGS.
func DefaultTaxSettings() TaxSettings {
	return TaxSettings{Rates: []TaxRates{DefaultTaxRates()}, DirectMode: ModeNet, Regencies: map[string]string{}}
}

// RoundHalfUp is roundHalfUp: whole rupiah, half away from zero.
func RoundHalfUp(v float64) int64 {
	if v < 0 {
		return -int64(math.Floor(-v + 0.5))
	}
	return int64(math.Floor(v + 0.5))
}

// jsRound is Math.round: half toward positive infinity.
func jsRound(v float64) int64 { return int64(math.Floor(v + 0.5)) }

// RatesOn is ratesOn: the rates a posting dated `date` uses; nil before the first rates start.
func RatesOn(t *TaxSettings, date string) *TaxRates {
	if t == nil {
		return nil
	}
	var found *TaxRates
	for i := range t.Rates {
		r := &t.Rates[i]
		if r.EffectiveFrom <= date && (found == nil || r.EffectiveFrom >= found.EffectiveFrom) {
			found = r
		}
	}
	return found
}

// TaxSplit is one charge line as its net, service and PB1.
type TaxSplit struct {
	Net     int64 `json:"net"`
	Service int64 `json:"service"`
	PB1     int64 `json:"pb1"`
}

// Gross is grossOf.
func (s TaxSplit) Gross() int64 { return s.Net + s.Service + s.PB1 }

// SumSplits is sumSplits.
func SumSplits(list []TaxSplit) TaxSplit {
	var out TaxSplit
	for _, s := range list {
		out.Net += s.Net
		out.Service += s.Service
		out.PB1 += s.PB1
	}
	return out
}

// Split is taxSplit: the service and PB1 of one charge on `code`. A net price adds them on top; an
// inclusive price is the gross, the net comes out of it and the rounding stays on PB1 (on service
// when the code carries no PB1), so the three add back to the price.
func Split(amount int64, code string, rates *TaxRates, mode string) TaxSplit {
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
	a := float64(amount)
	if mode == ModeNet {
		s := RoundHalfUp((a * service) / 100)
		base := a
		if rates.PB1OnService {
			base = float64(amount + s)
		}
		return TaxSplit{Net: amount, Service: s, PB1: RoundHalfUp((base * pb1) / 100)}
	}
	onService := 1.0
	if rates.PB1OnService {
		onService = 1 + service/100
	}
	factor := 1 + service/100 + (pb1/100)*onService
	net := RoundHalfUp(a / factor)
	s := amount - net
	if pb1 > 0 {
		s = RoundHalfUp((float64(net) * service) / 100)
	}
	return TaxSplit{Net: net, Service: s, PB1: amount - net - s}
}

// RebateSplit is rebateSplit: what a rebate of `amount` takes back off a line after `rebated` came
// off it already, the line's tax in proportion counted on the running total.
func RebateSplit(line TaxSplit, rebated, amount int64) TaxSplit {
	share := func(tax, part int64) int64 {
		if line.Net <= 0 {
			return 0
		}
		return RoundHalfUp(float64(tax*part) / float64(line.Net))
	}
	cut := func(tax int64) int64 { return share(tax, rebated+amount) - share(tax, rebated) }
	return TaxSplit{Net: amount, Service: cut(line.Service), PB1: cut(line.PB1)}
}

// ModeFor is modeFor: direct stays sell in the direct mode, channel stays inclusive.
func ModeFor(source string, t TaxSettings) string {
	if source == Direct {
		return t.DirectMode
	}
	return ModeInclusive
}

// StayMode is stayMode: a stay priced before the console reads inclusive.
func StayMode(b Booking) string {
	if b.PriceMode == "" {
		return ModeInclusive
	}
	return b.PriceMode
}

// NightDates is nightDates: each night's posting date.
func NightDates(b Booking) []string {
	audited := b.Posted()
	out := make([]string, len(b.ListRates))
	for i := range b.ListRates {
		switch {
		case i < len(audited):
			out[i] = audited[i]
		case b.Status == CheckedOut && b.CheckedOutOn != nil && *b.CheckedOutOn != "":
			out[i] = *b.CheckedOutOn
		default:
			out[i] = AddDays(b.CheckIn, i)
		}
	}
	return out
}

// NightSplits is nightSplits: each night on ROOM at the rates of the day it posts.
func NightSplits(b Booking, t *TaxSettings) []TaxSplit {
	dates := NightDates(b)
	charges := NightCharges(b)
	out := make([]TaxSplit, len(charges))
	for i, amount := range charges {
		date := b.CheckIn
		if i < len(dates) {
			date = dates[i]
		}
		out[i] = Split(amount, RoomCode, RatesOn(t, date), StayMode(b))
	}
	return out
}

// StayTax is stayTax.
type StayTax struct {
	TaxSplit
	Mode       string  `json:"mode"`
	Total      int64   `json:"total"`
	ServicePct float64 `json:"servicePct"`
	PB1Pct     float64 `json:"pb1Pct"`
}

// StayTaxOf is stayTax: the room with its tax and the rates the note quotes.
func StayTaxOf(b Booking, t *TaxSettings) StayTax {
	s := SumSplits(NightSplits(b, t))
	out := StayTax{TaxSplit: s, Mode: StayMode(b), Total: s.Gross()}
	if r := RatesOn(t, b.CheckIn); r != nil {
		out.ServicePct, out.PB1Pct = r.ServicePct, r.PB1Pct
	}
	return out
}

// TaxNote is taxNote: the line under a price.
func TaxNote(t StayTax) string {
	if t.ServicePct == 0 && t.PB1Pct == 0 {
		return ""
	}
	verb := "include"
	if t.Mode == ModeNet {
		verb = "exclude"
	}
	return "Prices " + verb + " " + pct(t.ServicePct) + "% service and " + pct(t.PB1Pct) + "% PB1"
}

// TaxSettingsInput is TaxSettingsInput.
type TaxSettingsInput struct {
	Rates      TaxRates          `json:"rates"`
	DirectMode string            `json:"directMode"`
	Regencies  map[string]string `json:"regencies"`
}

var isoDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// ValidateTaxSettings is validateTaxSettings; codes are the charge codes.
func ValidateTaxSettings(in TaxSettingsInput, codes []string) error {
	var f errs.Fields
	r := in.Rates
	if !isoDate.MatchString(r.EffectiveFrom) {
		f.Add("effectiveFrom", "Pick the date the rates start.")
	}
	if !(r.ServicePct >= 0 && r.ServicePct <= 25) {
		f.Add("servicePct", "A percentage from 0 to 25.")
	}
	if !(r.PB1Pct >= 0 && r.PB1Pct <= 25) {
		f.Add("pb1Pct", "A percentage from 0 to 25.")
	}
	for _, c := range append(slices.Clone(r.ServiceCodes), r.PB1Codes...) {
		if !slices.Contains(codes, c) {
			f.Add("codes", "Pick charge codes from the list.")
			break
		}
	}
	for _, v := range in.Regencies {
		if len(strings.TrimSpace(v)) < 3 {
			f.Add("regencies", "Name the regency of every location.")
			break
		}
	}
	return f.Err()
}

// SameRates is sameRates: whether two rate sets charge the same, whatever their dates.
func SameRates(a, b TaxRates) bool {
	codes := func(list []string) string {
		c := slices.Clone(list)
		sort.Strings(c)
		return strings.Join(c, ",")
	}
	return a.ServicePct == b.ServicePct && a.PB1Pct == b.PB1Pct && a.PB1OnService == b.PB1OnService &&
		codes(a.ServiceCodes) == codes(b.ServiceCodes) && codes(a.PB1Codes) == codes(b.PB1Codes)
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
	sort.SliceStable(out, func(i, j int) bool { return out[i].EffectiveFrom < out[j].EffectiveFrom })
	return out
}

// SaveTaxSettings applies a save on `today`: new rates start today or later (TAX_RATES_BACKDATED);
// rates equal to the ones in force keep the list as it is. It returns the settings and the rates it
// added, nil when only the mode or the regencies changed.
func SaveTaxSettings(current TaxSettings, in TaxSettingsInput, codes []string, today string) (TaxSettings, *TaxRates, error) {
	if err := ValidateTaxSettings(in, codes); err != nil {
		return current, nil, err
	}
	now := RatesOn(&current, in.Rates.EffectiveFrom)
	changed := now == nil || !SameRates(*now, in.Rates)
	if changed && in.Rates.EffectiveFrom < today {
		return current, nil, errs.Newf("TAX_RATES_BACKDATED", "New rates start today or later; postings before %s keep the rates they were made at.", today)
	}
	out := TaxSettings{Rates: current.Rates, DirectMode: in.DirectMode, Regencies: map[string]string{}}
	for k, v := range in.Regencies {
		out.Regencies[k] = strings.TrimSpace(v)
	}
	if !changed {
		return out, nil, nil
	}
	r := in.Rates
	r.ServiceCodes, r.PB1Codes = slices.Clone(r.ServiceCodes), slices.Clone(r.PB1Codes)
	out.Rates = WithRates(current, r)
	return out, &r, nil
}
