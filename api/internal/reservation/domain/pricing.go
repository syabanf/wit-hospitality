package domain

import (
	"math"
	"strings"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// PriceSource says where a night's list price came from: the live listing, the room type's rate
// plan (with the name of the rate) or what the channel sold.
type PriceSource struct {
	Kind string `json:"kind"`
	Name string `json:"name,omitempty"`
}

// NightPrice is one priced night.
type NightPrice struct {
	Date   string      `json:"date"`
	Rate   int64       `json:"rate"`
	Source PriceSource `json:"source"`
}

// Discount is DiscountInput: percent (0 to 100) or whole rupiah, per night or per stay.
type Discount struct {
	Kind   string  `json:"kind"`
	Value  float64 `json:"value"`
	Per    string  `json:"per"`
	Reason string  `json:"reason"`
}

// PriceStamp is who last priced a direct stay away from the list.
type PriceStamp struct {
	By         string  `json:"by"`
	ByID       string  `json:"byId"`
	On         string  `json:"on"`
	Reason     string  `json:"reason"`
	ApprovedBy *string `json:"approvedBy"`
}

// PriceChange is a staff change to a direct stay's price.
type PriceChange struct {
	RateOverride *float64  `json:"rateOverride"`
	Discount     *Discount `json:"discount"`
	Reason       string    `json:"reason"`
}

// Priced is what the price rules read off a stay.
type Priced struct {
	ListRates    []int64
	RateOverride *int64
	Discount     *Discount
}

// Priced returns the stay's price inputs.
func (b Booking) Priced() Priced {
	return Priced{ListRates: b.ListRates, RateOverride: b.RateOverride, Discount: b.Discount}
}

func sum(list []int64) int64 {
	var s int64
	for _, v := range list {
		s += v
	}
	return s
}

// jsRound is Math.round for the non-negative amounts prices use.
func jsRound(v float64) int64 { return int64(math.Floor(v + 0.5)) }

func discountOff(subtotal int64, nights int, d *Discount) int64 {
	if d == nil {
		return 0
	}
	var off int64
	switch {
	case d.Kind == "percent":
		off = jsRound(float64(subtotal) * d.Value / 100)
	case d.Per == "night":
		off = int64(d.Value) * int64(nights)
	default:
		off = int64(d.Value)
	}
	return min(subtotal, max(0, off))
}

// NightCharges is nightCharges: each night after the override and the discount, adding up to the
// total exactly.
func NightCharges(s Priced) []int64 {
	base := make([]int64, len(s.ListRates))
	for i, r := range s.ListRates {
		base[i] = r
		if s.RateOverride != nil {
			base[i] = *s.RateOverride
		}
	}
	subtotal := sum(base)
	off := discountOff(subtotal, len(base), s.Discount)
	if off == 0 {
		return base
	}
	var given int64
	out := make([]int64, len(base))
	for i, r := range base {
		share := off - given
		if i != len(base)-1 {
			share = int64(math.Floor(float64(off) * float64(r) / float64(subtotal)))
		}
		given += share
		out[i] = r - share
	}
	return out
}

// StayPrice is the price of a stay against its list.
type StayPrice struct {
	List      int64   `json:"list"`
	Subtotal  int64   `json:"subtotal"`
	Discount  int64   `json:"discount"`
	Total     int64   `json:"total"`
	Reduction float64 `json:"reduction"`
}

// PriceOf is stayPrice.
func PriceOf(s Priced) StayPrice {
	list := sum(s.ListRates)
	subtotal := list
	if s.RateOverride != nil {
		subtotal = *s.RateOverride * int64(len(s.ListRates))
	}
	charged := sum(NightCharges(s))
	p := StayPrice{List: list, Subtotal: subtotal, Discount: subtotal - charged, Total: charged}
	if list > 0 {
		p.Reduction = math.Max(0, float64(list-charged)/float64(list))
	}
	return p
}

// BeyondDiscountLimit is beyondDiscountLimit.
func BeyondDiscountLimit(p StayPrice, limitPct float64) bool { return p.Reduction*100 > limitPct+1e-9 }

// ValidatePriceChange is validatePriceChange.
func ValidatePriceChange(p PriceChange) error {
	var f errs.Fields
	if p.RateOverride != nil && (!whole(*p.RateOverride) || *p.RateOverride <= 0) {
		f.Add("rateOverride", "Enter the nightly rate in whole rupiah.")
	}
	if p.RateOverride != nil && p.Discount == nil && len([]rune(strings.TrimSpace(p.Reason))) < 3 {
		f.Add("reason", "Say why the rate changes.")
	}
	if d := p.Discount; d != nil {
		if d.Kind == "percent" && !(d.Value > 0 && d.Value <= 100) {
			f.Add("discount.value", "A percentage above 0, up to 100.")
		}
		if d.Kind == "amount" && (!whole(d.Value) || d.Value <= 0) {
			f.Add("discount.value", "Enter the discount in whole rupiah.")
		}
		if len([]rune(strings.TrimSpace(d.Reason))) < 3 {
			f.Add("discount.reason", "Say why the guest gets the discount.")
		}
	}
	return f.Err()
}

// RepriceNights is repriceNights: nights the stay already had keep their price, new nights take
// priceFor.
func RepriceNights[T any](checkInBefore string, sold []T, checkIn, checkOut string, priceFor func(date string) T) []T {
	var out []T
	for _, date := range EachDay(checkIn, checkOut) {
		at := DaysBetween(checkInBefore, date)
		if at >= 0 && at < len(sold) {
			out = append(out, sold[at])
		} else {
			out = append(out, priceFor(date))
		}
	}
	return out
}

// SoldNights is soldNights: each night with its source; stays priced before sources were kept read
// as the listing or the channel.
func (b Booking) SoldNights() []NightPrice {
	out := make([]NightPrice, len(b.ListRates))
	for i, rate := range b.ListRates {
		src := PriceSource{Kind: "listing"}
		if b.Source != Direct {
			src = PriceSource{Kind: "channel"}
		}
		if b.ListSources != nil && i < len(*b.ListSources) {
			src = (*b.ListSources)[i]
		}
		out[i] = NightPrice{Date: AddDays(b.CheckIn, i), Rate: rate, Source: src}
	}
	return out
}

// SetNights stores list prices and their sources.
func (b *Booking) SetNights(nights []NightPrice) {
	rates := make([]int64, len(nights))
	sources := make([]PriceSource, len(nights))
	for i, n := range nights {
		rates[i], sources[i] = n.Rate, n.Source
	}
	b.ListRates, b.ListSources = rates, &sources
}

// ChannelPrice prices every night at what the channel sold.
func ChannelPrice(rate int64) func(string) NightPrice {
	return func(date string) NightPrice {
		return NightPrice{Date: date, Rate: rate, Source: PriceSource{Kind: "channel"}}
	}
}

// Actor is who changes a stay.
type Actor struct {
	ID   string
	Name string
}

// ApplyPrice is the mock's applyPrice: a staff price on a direct stay. Going further under the list
// than limitPct needs someone who may approve bookings; their name goes on the stamp.
func (b *Booking) ApplyPrice(price PriceChange, by Actor, mayApprove bool, limitPct float64, today string) (StayPrice, error) {
	if b.IsChannel() {
		return StayPrice{}, ErrChannelPriceLocked(*b)
	}
	if err := ValidatePriceChange(price); err != nil {
		return StayPrice{}, err
	}
	next := Priced{ListRates: b.ListRates}
	if price.RateOverride != nil {
		r := int64(*price.RateOverride)
		next.RateOverride = &r
	}
	if price.Discount != nil {
		d := *price.Discount
		d.Reason = strings.TrimSpace(d.Reason)
		next.Discount = &d
	}
	quoted := PriceOf(next)
	beyond := BeyondDiscountLimit(quoted, limitPct)
	if beyond && !mayApprove {
		return StayPrice{}, errs.Newf("DISCOUNT_LIMIT", "%d%% under the list is past the %s%% limit. Ask a villa manager to give it.", jsRound(quoted.Reduction*100), number(limitPct))
	}
	b.RateOverride, b.Discount = next.RateOverride, next.Discount
	b.PriceSetBy = nil
	if next.RateOverride != nil || next.Discount != nil {
		stamp := PriceStamp{By: by.Name, ByID: by.ID, On: today, Reason: strings.TrimSpace(price.Reason)}
		if beyond {
			name := by.Name
			stamp.ApprovedBy = &name
		}
		b.PriceSetBy = &stamp
	}
	return quoted, nil
}

// Season comes back every year; From and To are MM-DD, both included.
type Season struct {
	Name  string `json:"name"`
	From  string `json:"from"`
	To    string `json:"to"`
	Kind  string `json:"kind"`
	Value int64  `json:"value"`
}

// RatePlan prices a room type's nights when a unit has no live listing.
type RatePlan struct {
	GroupID     string   `json:"groupId"`
	WeekdayRate int64    `json:"weekdayRate"`
	WeekendRate int64    `json:"weekendRate"`
	Seasons     []Season `json:"seasons"`
}

func seasonLength(s Season) int {
	from, _ := time.Parse(dateLayout, "2024-"+s.From)
	to, _ := time.Parse(dateLayout, "2024-"+s.To)
	span := int(to.Sub(from).Hours() / 24)
	if span < 0 {
		span += 366
	}
	return span + 1
}

// InYearlyRange is inYearlyRange: MM-DD bounds, both included, possibly over the new year.
func InYearlyRange(from, to, date string) bool {
	md := date[5:]
	if from <= to {
		return md >= from && md <= to
	}
	return md >= from || md <= to
}

func seasonOn(seasons []Season, date string) *Season {
	var found *Season
	for i := range seasons {
		s := &seasons[i]
		if InYearlyRange(s.From, s.To, date) && (found == nil || seasonLength(*s) <= seasonLength(*found)) {
			found = s
		}
	}
	return found
}

// PlanNight is planNight: Friday and Saturday nights sell at the weekend rate, a season overrides.
func PlanNight(p RatePlan, date string) (int64, string) {
	weekend := WeekdayIndex(date) == 4 || WeekdayIndex(date) == 5
	base, name := p.WeekdayRate, "Weekday"
	if weekend {
		base, name = p.WeekendRate, "Weekend"
	}
	s := seasonOn(p.Seasons, date)
	if s == nil {
		return base, name
	}
	if s.Kind == "fixed" {
		return s.Value, s.Name
	}
	return jsRound(float64(base) * float64(100+s.Value) / 100), s.Name
}

// Listing is a unit's live channel listing as pricing needs it.
type Listing struct {
	DateRates map[string]int64
}

// PriceList is the list that prices a direct stay: the live listing, else the rate plan.
type PriceList struct {
	Kind    string
	Listing Listing
	Plan    RatePlan
}

// PriceListFor is priceListFor; nil when there is nothing to sell at.
func PriceListFor(c Catalog, unit Unit, listing *Listing) *PriceList {
	if listing != nil {
		return &PriceList{Kind: "listing", Listing: *listing}
	}
	if p, ok := c.Plan(unit.Group()); ok {
		return &PriceList{Kind: "plan", Plan: p}
	}
	return nil
}

// Night is listNight.
func (l PriceList) Night(baseRate int64, date string) NightPrice {
	if l.Kind == "listing" {
		rate, ok := l.Listing.DateRates[date]
		if !ok {
			rate = baseRate
		}
		return NightPrice{Date: date, Rate: rate, Source: PriceSource{Kind: "listing"}}
	}
	rate, name := PlanNight(l.Plan, date)
	return NightPrice{Date: date, Rate: rate, Source: PriceSource{Kind: "plan", Name: name}}
}

// ErrNoPrice is NO_PRICE with noPriceMessage.
func ErrNoPrice(unitCode string) error {
	return errs.Newf("NO_PRICE", "%s has no live Airbnb listing and its room type has no rate plan. Add a rate plan on the room type page.", unitCode)
}

// Policy is the part of the payment policy and tax settings reservation reads. Billing and
// finance own them; until they run, the TypeScript defaults apply.
type Policy struct {
	DepositPct       float64
	FreeCancelDays   int
	DiscountLimitPct float64
	DirectMode       string
	ServicePct       float64
	PB1Pct           float64
	PB1OnService     bool
}

// DefaultPolicy is DEFAULT_PAYMENT_POLICY and DEFAULT_TAX_SETTINGS.
var DefaultPolicy = Policy{DepositPct: 30, FreeCancelDays: 14, DiscountLimitPct: 10, DirectMode: "net", ServicePct: 10, PB1Pct: 10, PB1OnService: true}

// ModeFor is modeFor: direct stays sell in the direct mode, channel stays inclusive.
func (p Policy) ModeFor(source string) string {
	if source == Direct {
		return p.DirectMode
	}
	return "inclusive"
}

func roundHalfUp(v float64) int64 {
	if v < 0 {
		return -int64(math.Floor(-v + 0.5))
	}
	return int64(math.Floor(v + 0.5))
}

// StayTotal is stayTax(b).total: each night on the ROOM code with service and PB1, added on top
// for a net price, inside an inclusive one. Stays without a mode read inclusive.
func (p Policy) StayTotal(b Booking) int64 {
	var total int64
	for _, amount := range NightCharges(b.Priced()) {
		if b.PriceMode != "net" || (p.ServicePct == 0 && p.PB1Pct == 0) {
			total += amount
			continue
		}
		s := roundHalfUp(float64(amount) * p.ServicePct / 100)
		base := amount
		if p.PB1OnService {
			base += s
		}
		total += amount + s + roundHalfUp(float64(base)*p.PB1Pct/100)
	}
	return total
}

// DepositAmount is depositAmount: the deposit share of a total, rounded to Rp 10,000.
func (p Policy) DepositAmount(total int64) int64 {
	return jsRound(float64(total)*p.DepositPct/100/10_000) * 10_000
}

// CancellationTerms is what cancelling or a no-show does with the money paid.
type CancellationTerms struct {
	Refund   int64 `json:"refund"`
	Retained int64 `json:"retained"`
}

// Cancellation is cancellationTerms: a no-show keeps everything; a cancellation at least
// FreeCancelDays before arrival gets everything back, later the villa keeps the deposit.
func (p Policy) Cancellation(paid, total int64, checkIn, today, outcome string) CancellationTerms {
	if paid <= 0 {
		return CancellationTerms{}
	}
	if outcome == NoShow {
		return CancellationTerms{Retained: paid}
	}
	var keep int64
	if DaysBetween(today, checkIn) < p.FreeCancelDays {
		keep = min(paid, p.DepositAmount(total))
	}
	return CancellationTerms{Refund: paid - keep, Retained: keep}
}
