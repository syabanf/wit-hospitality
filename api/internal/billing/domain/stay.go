package domain

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
)

// Booking statuses and sources, as reservation publishes them.
const (
	Draft      = "draft"
	Confirmed  = "confirmed"
	CheckedIn  = "checked_in"
	CheckedOut = "checked_out"
	Cancelled  = "cancelled"
	NoShow     = "no_show"
	Direct     = "direct"
)

// Discount is the stay's discount as reservation keeps it.
type Discount struct {
	Kind  string  `json:"kind"`
	Value float64 `json:"value"`
	Per   string  `json:"per"`
}

// PriceStamp names who priced a stay away from its list.
type PriceStamp struct {
	By string `json:"by"`
}

// Arrival is the part of the check-in record the folio reads.
type Arrival struct {
	Deposit float64 `json:"deposit"`
}

// Departure is CheckOutDetails.
type Departure struct {
	DepositReturned float64 `json:"depositReturned"`
	ExtraCharges    float64 `json:"extraCharges"`
	RoomInspected   bool    `json:"roomInspected"`
	KeysReturned    bool    `json:"keysReturned"`
	Notes           string  `json:"notes"`
}

// Booking is billing's copy of a reservation booking: the fields the folio, the night audit and
// payments read. Reservation publishes the whole record; the rest is ignored.
type Booking struct {
	ID             string          `json:"id"`
	Code           string          `json:"code"`
	GuestID        string          `json:"guestId"`
	UnitID         string          `json:"unitId"`
	UnitAssigned   bool            `json:"unitAssigned"`
	Source         string          `json:"source"`
	CheckIn        string          `json:"checkIn"`
	CheckOut       string          `json:"checkOut"`
	ListRates      []int64         `json:"listRates"`
	PriceMode      string          `json:"priceMode,omitempty"`
	RateOverride   *int64          `json:"rateOverride"`
	Discount       *Discount       `json:"discount"`
	PriceSetBy     *PriceStamp     `json:"priceSetBy"`
	Status         string          `json:"status"`
	PaidAmount     float64         `json:"paidAmount"`
	AirbnbFee      float64         `json:"airbnbFee"`
	CheckedInOn    *string         `json:"checkedInOn"`
	CheckedOutOn   *string         `json:"checkedOutOn"`
	Arrival        *Arrival        `json:"arrival"`
	Departure      *Departure      `json:"departure"`
	BookingGroupID string          `json:"bookingGroupId,omitempty"`
	NightsPosted   *[]string       `json:"nightsPosted,omitempty"`
	CityLedger     json.RawMessage `json:"cityLedger,omitempty"`
}

// IsChannel is isChannel: the channel collects the room.
func (b Booking) IsChannel() bool { return b.Source != Direct }

// Posted is the dates the night audit posted, in night order.
func (b Booking) Posted() []string {
	if b.NightsPosted == nil {
		return nil
	}
	return *b.NightsPosted
}

// LiveStay is liveStay: still to arrive, in house or waiting to be confirmed.
func LiveStay(status string) bool {
	return status == Draft || status == Confirmed || status == CheckedIn
}

// Group is billing's copy of a booking group.
type Group struct {
	ID          string          `json:"id"`
	Code        string          `json:"code"`
	Name        string          `json:"name"`
	LeadGuestID string          `json:"leadGuestId"`
	Billing     string          `json:"billing"`
	VillaIDs    []string        `json:"villaIds"`
	CityLedger  json.RawMessage `json:"cityLedger,omitempty"`
}

// ClosesGroup is closesGroup: whether bookingID is the last stay of the group still to leave.
func ClosesGroup(stays []Booking, bookingID string) bool {
	for _, b := range stays {
		if b.ID != bookingID && LiveStay(b.Status) {
			return false
		}
	}
	return true
}

func sum(list []int64) int64 {
	var s int64
	for _, v := range list {
		s += v
	}
	return s
}

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

// NightCharges is nightCharges: each night after the staff rate and the discount, adding up to the
// total exactly.
func NightCharges(b Booking) []int64 {
	base := make([]int64, len(b.ListRates))
	for i, r := range b.ListRates {
		base[i] = r
		if b.RateOverride != nil {
			base[i] = *b.RateOverride
		}
	}
	subtotal := sum(base)
	off := discountOff(subtotal, len(base), b.Discount)
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

// AddDays and DaysBetween work on YYYY-MM-DD dates.
func AddDays(d string, n int) string { return clock.AddDays(d, n) }

// DaysBetween counts the days from a to b.
func DaysBetween(a, b string) int { return clock.DaysBetween(a, b) }

// Rupiah formats a whole amount the way toLocaleString('id-ID') does: 1.250.000.
func Rupiah(v int64) string {
	neg := v < 0
	if neg {
		v = -v
	}
	s := strconv.FormatInt(v, 10)
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte('.')
		}
		b.WriteRune(c)
	}
	if neg {
		return "-" + b.String()
	}
	return b.String()
}

// Pct prints a percentage the way JavaScript prints a number: 10, 2.9.
func Pct(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// OrderLine is one line of a room service order.
type OrderLine struct {
	Name     string  `json:"name"`
	Category string  `json:"category"`
	Price    float64 `json:"price"`
	Quantity float64 `json:"quantity"`
	Comp     bool    `json:"comp"`
}

// OrderHistory is one step of an order.
type OrderHistory struct {
	Kind string `json:"kind"`
	By   string `json:"by"`
}

// Order is the part of a services ServiceOrder the folio reads. Services owns orders; billing reads
// them through command.Orders.
type Order struct {
	ID             string         `json:"id"`
	Number         string         `json:"number"`
	BookingID      string         `json:"bookingId"`
	Lines          []OrderLine    `json:"lines"`
	Status         string         `json:"status"`
	RequestedOn    string         `json:"requestedOn"`
	RequestedAt    int            `json:"requestedAt"`
	DeliveredOn    *string        `json:"deliveredOn"`
	DeliveredAt    *int           `json:"deliveredAt"`
	DiscountPct    float64        `json:"discountPct"`
	DiscountReason string         `json:"discountReason"`
	CompReason     string         `json:"compReason"`
	Assignee       string         `json:"assignee"`
	History        []OrderHistory `json:"history"`
	// Codes is the charge per transaction code as services billed it; empty, billing splits the lines.
	Codes []CodeAmount `json:"codes,omitempty"`
}

// LineAmount is lineAmount.
func LineAmount(l OrderLine) int64 { return jsRound(l.Price * l.Quantity) }

// OrderCharge is orderTotals(o).charge: what the guest pays for the order.
func OrderCharge(o Order) int64 {
	var gross, comp int64
	for _, l := range o.Lines {
		gross += LineAmount(l)
		if l.Comp {
			comp += LineAmount(l)
		}
	}
	return gross - comp - jsRound(float64(gross-comp)*o.DiscountPct/100)
}

// MenuCategoryCode is MENU_CATEGORY_CODE.
var MenuCategoryCode = map[string]string{"breakfast": "FNB", "food": "FNB", "minibar": "MINI", "laundry": "LDRY", "transport": "TRNS",
	"spa": "SPA", "tours": "TOUR", "extras": "XTRA", "housekeeping": "XTRA"}

// RevenueCategory is REVENUE_CATEGORY: the income category of each menu category.
var RevenueCategory = map[string]string{"breakfast": "cat-svc-fnb", "food": "cat-svc-fnb", "minibar": "cat-svc-fnb", "laundry": "cat-svc-laundry",
	"transport": "cat-svc-transport", "spa": "cat-svc-spa", "tours": "cat-svc-tours", "extras": "cat-svc-other", "housekeeping": "cat-svc-other"}

// KeyAmount is one share of an order's charge.
type KeyAmount struct {
	Key    string
	Amount int64
}

// chargeSplit spreads the charge by a key of the line; the discount spreads pro rata and the
// rounding lands on the biggest share.
func chargeSplit(o Order, keyOf func(OrderLine) string) []KeyAmount {
	charge := OrderCharge(o)
	var order []string
	gross := map[string]int64{}
	for _, l := range o.Lines {
		if l.Comp {
			continue
		}
		k := keyOf(l)
		if _, ok := gross[k]; !ok {
			order = append(order, k)
		}
		gross[k] += LineAmount(l)
	}
	var before int64
	for _, k := range order {
		before += gross[k]
	}
	if before == 0 || charge == 0 {
		return nil
	}
	shares := make([]KeyAmount, len(order))
	var given int64
	for i, k := range order {
		shares[i] = KeyAmount{Key: k, Amount: int64(math.Floor(float64(gross[k]*charge) / float64(before)))}
		given += shares[i].Amount
	}
	// Stable sort by amount, largest first, as Array.prototype.sort does.
	for i := 1; i < len(shares); i++ {
		for j := i; j > 0 && shares[j].Amount > shares[j-1].Amount; j-- {
			shares[j], shares[j-1] = shares[j-1], shares[j]
		}
	}
	shares[0].Amount += charge - given
	out := shares[:0]
	for _, s := range shares {
		if s.Amount > 0 {
			out = append(out, s)
		}
	}
	return out
}

// CodeAmount is the charge under one transaction code.
type CodeAmount struct {
	Code   string `json:"code"`
	Amount int64  `json:"amount"`
}

// CodeSplit is codeSplit: the charge per transaction code.
func CodeSplit(o Order) []KeyAmount {
	if len(o.Codes) > 0 {
		out := make([]KeyAmount, len(o.Codes))
		for i, c := range o.Codes {
			out[i] = KeyAmount{Key: c.Code, Amount: c.Amount}
		}
		return out
	}
	return chargeSplit(o, func(l OrderLine) string { return MenuCategoryCode[l.Category] })
}

// RevenueSplit is revenueSplit: the charge per income category.
func RevenueSplit(o Order) []KeyAmount {
	return chargeSplit(o, func(l OrderLine) string { return RevenueCategory[l.Category] })
}

// OrderSummary is orderSummary.
func OrderSummary(lines []OrderLine) string {
	parts := make([]string, len(lines))
	for i, l := range lines {
		parts[i] = strconv.FormatFloat(l.Quantity, 'f', -1, 64) + " × " + l.Name
	}
	return strings.Join(parts, ", ")
}
