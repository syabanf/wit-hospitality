package domain

import (
	"math"

	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
)

// Discount is a direct stay's discount, as reservation publishes it.
type Discount struct {
	Kind   string  `json:"kind"`
	Value  float64 `json:"value"`
	Per    string  `json:"per"`
	Reason string  `json:"reason"`
}

// Stay is what owners reads off a booking reservation published.
type Stay struct {
	ID              string    `json:"id"`
	Code            string    `json:"code"`
	UnitID          string    `json:"unitId"`
	UnitAssigned    bool      `json:"unitAssigned"`
	Source          string    `json:"source"`
	BookingGroupID  *string   `json:"bookingGroupId"`
	AirbnbAccountID *string   `json:"airbnbAccountId"`
	CheckIn         string    `json:"checkIn"`
	CheckOut        string    `json:"checkOut"`
	ListRates       []int64   `json:"listRates"`
	RateOverride    *int64    `json:"rateOverride"`
	Discount        *Discount `json:"discount"`
	Status          string    `json:"status"`
	CreatedOn       string    `json:"createdOn"`
	AirbnbFee       float64   `json:"airbnbFee"`
}

// SourceLabel is SOURCE_LABEL.
var SourceLabel = map[string]string{"direct": "Direct", "airbnb": "Airbnb"}

// Segment is segmentOf: Airbnb by source, corporate by the source of the stay's booking group,
// direct otherwise.
func (s Stay) Segment(groupSource string) string {
	switch {
	case s.Source == "airbnb":
		return "airbnb"
	case groupSource == "corporate":
		return "corporate"
	default:
		return "direct"
	}
}

// Earns is earns: every status a guest stays or stayed for.
func (s Stay) Earns() bool { return s.Status != "draft" && s.Status != "cancelled" }

// NightCharges is nightCharges: each night after the override and the discount, adding up to the
// stay's total exactly.
func (s Stay) NightCharges() []int64 {
	base := make([]int64, len(s.ListRates))
	var subtotal int64
	for i, r := range s.ListRates {
		base[i] = r
		if s.RateOverride != nil {
			base[i] = *s.RateOverride
		}
		subtotal += base[i]
	}
	var off int64
	if d := s.Discount; d != nil {
		switch {
		case d.Kind == "percent":
			off = jsRound(float64(subtotal) * d.Value / 100)
		case d.Per == "night":
			off = int64(d.Value) * int64(len(base))
		default:
			off = int64(d.Value)
		}
		off = min(subtotal, max(0, off))
	}
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

// ChargedBetween is chargedBetween: what the stay charges for its nights inside [from, to).
func (s Stay) ChargedBetween(from, to string) int64 {
	var sum int64
	for i, c := range s.NightCharges() {
		if d := clock.AddDays(s.CheckIn, i); d >= from && d < to {
			sum += c
		}
	}
	return sum
}
