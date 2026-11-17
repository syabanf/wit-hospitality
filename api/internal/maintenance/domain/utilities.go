package domain

import (
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Meters, readings and what the usage bills, ported from src/domain/utilities.ts
// (villa-operations-contract.md section 3).

// MeterKinds is METER_KINDS.
var MeterKinds = []string{"electricity", "water", "gas"}

// MeterKindLabel is METER_KIND_LABEL.
var MeterKindLabel = map[string]string{"electricity": "Electricity", "water": "Water", "gas": "Gas"}

// MeterUnitOf is METER_UNIT_OF.
var MeterUnitOf = map[string]string{"electricity": "kWh", "water": "m3", "gas": "m3"}

// MeterPayers is METER_PAYERS.
var MeterPayers = []string{"guest", "owner", "operator"}

// ReadingPurposes is READING_PURPOSES.
var ReadingPurposes = []string{"monthly", "check_in", "check_out"}

// DefaultLongStayNights is DEFAULT_LONG_STAY_NIGHTS.
const DefaultLongStayNights = 28

// Meter is an electricity, water or gas meter of a villa or one of its units.
type Meter struct {
	ID      string  `json:"id"`
	VillaID string  `json:"villaId"`
	UnitID  *string `json:"unitId"`
	Kind    string  `json:"kind"`
	Number  string  `json:"number"`
	Unit    string  `json:"unit"`
	Tariff  int64   `json:"tariff"`
	Payer   string  `json:"payer"`
	Active  bool    `json:"active"`
}

// MeterInput is MeterInput.
type MeterInput struct {
	VillaID string  `json:"villaId"`
	UnitID  *string `json:"unitId"`
	Kind    string  `json:"kind"`
	Number  string  `json:"number"`
	Unit    string  `json:"unit"`
	Tariff  float64 `json:"tariff"`
	Payer   string  `json:"payer"`
	Active  bool    `json:"active"`
}

// ValidateMeter is validateMeter. villaMeters are the villa's meters; unitVilla answers a unit's
// villa ("" when unknown).
func ValidateMeter(in MeterInput, villaID, villaName string, villaMeters []Meter, unitVilla func(string) string, current *Meter) error {
	var f errs.Fields
	if current != nil && in.VillaID != current.VillaID {
		f.Add("villaId", "A meter stays with its villa.")
	}
	number := strings.TrimSpace(in.Number)
	if n := len([]rune(number)); n < 2 || n > 30 {
		f.Add("number", "Enter the meter number.")
	} else {
		for _, m := range villaMeters {
			if (current == nil || m.ID != current.ID) && strings.EqualFold(m.Number, number) {
				f.Add("number", fmt.Sprintf("%s is already a meter of %s.", number, villaName))
				break
			}
		}
	}
	if !slices.Contains(MeterKinds, in.Kind) {
		f.Add("kind", "Pick electricity, water or gas.")
	} else if MeterUnitOf[in.Kind] != in.Unit {
		f.Add("unit", "Electricity reads in kWh, water and gas in m3.")
	}
	if !whole(in.Tariff) || in.Tariff < 0 {
		f.Add("tariff", "Whole rupiah per unit, zero or more.")
	}
	if !slices.Contains(MeterPayers, in.Payer) {
		f.Add("payer", "Pick who pays.")
	}
	if in.UnitID != nil && *in.UnitID != "" && unitVilla(*in.UnitID) != villaID {
		f.Add("unitId", "Pick a unit of this villa.")
	}
	return f.Err()
}

// ValidateLongStay is validateLongStay.
func ValidateLongStay(nights float64) error {
	if !whole(nights) || nights < 1 || nights > 365 {
		return errs.Invalid("longStayNights", "A whole number of nights from 1 to 365.")
	}
	return nil
}

// UtilitySettings is a villa's long-stay length.
type UtilitySettings struct {
	VillaID        string `json:"villaId"`
	LongStayNights int    `json:"longStayNights"`
}

// MeterReading is one reading of a meter.
type MeterReading struct {
	ID          string   `json:"id"`
	MeterID     string   `json:"meterId"`
	VillaID     string   `json:"villaId"`
	UnitID      *string  `json:"unitId"`
	On          string   `json:"on"`
	Value       float64  `json:"value"`
	Photo       *string  `json:"photo"`
	Purpose     string   `json:"purpose"`
	BookingID   *string  `json:"bookingId"`
	BookingCode *string  `json:"bookingCode"`
	Replacement bool     `json:"replacement"`
	Previous    *float64 `json:"previous"`
	Consumption float64  `json:"consumption"`
	Amount      int64    `json:"amount"`
	BilledTo    *string  `json:"billedTo"`
	By          string   `json:"by"`
	ByID        string   `json:"byId"`
}

// ReadingInput is ReadingInput.
type ReadingInput struct {
	MeterID     string   `json:"meterId"`
	On          string   `json:"on"`
	Value       *float64 `json:"value"`
	Photo       *string  `json:"photo"`
	Purpose     string   `json:"purpose"`
	BookingID   *string  `json:"bookingId"`
	Replacement bool     `json:"replacement"`
}

// ReadingStay is a stay as the reading rules see it.
type ReadingStay struct {
	ID       string
	Code     string
	UnitID   string
	Status   string
	CheckIn  string
	CheckOut string
}

// ReadingContext is what validateReading reads besides the form. Readings are the meter's, in the
// order they were recorded.
type ReadingContext struct {
	Meter          Meter
	Readings       []MeterReading
	Today          string
	Stay           *ReadingStay
	LongStayNights int
	Serves         func(unitID string) bool
	Nights         func(from, to string) int
}

// Round2 is round2.
func Round2(n float64) float64 { return math.Round(n*100) / 100 }

// Num prints a number as JavaScript does in a template string.
func Num(n float64) string { return strconv.FormatFloat(n, 'f', -1, 64) }

func purposeWord(p string) string {
	if p == "check_in" {
		return "check-in"
	}
	return "check-out"
}

// ValidateReading is validateReading: the field rules, then the rule refusals in the API's order.
// It returns the previous value and the consumption the reading records.
func ValidateReading(in ReadingInput, c ReadingContext) (previous *float64, consumption float64, err error) {
	var f errs.Fields
	switch {
	case !ValidDate(in.On):
		f.Add("on", "Pick the reading date.")
	case in.On > c.Today:
		f.Add("on", "A reading cannot be dated after today.")
	}
	if in.Value == nil || *in.Value < 0 || math.IsInf(*in.Value, 0) || math.Abs(Round2(*in.Value)-*in.Value) > 1e-9 {
		f.Add("value", "Enter the meter value.")
	}
	if !slices.Contains(ReadingPurposes, in.Purpose) {
		f.Add("purpose", "Pick monthly, check-in or check-out.")
	}
	if err := f.Err(); err != nil {
		return nil, 0, err
	}
	m := c.Meter
	value := *in.Value
	if !m.Active {
		return nil, 0, errs.New("METER_INACTIVE", m.Number+" is out of use.")
	}
	var last *MeterReading
	if n := len(c.Readings); n > 0 {
		last = &c.Readings[n-1]
	}
	if last != nil && in.On < last.On {
		return nil, 0, errs.Newf("READING_OUT_OF_ORDER", "%s was last read on %s; record readings in date order.", m.Number, last.On)
	}
	if last != nil && value < last.Value && !in.Replacement {
		return nil, 0, errs.Newf("READING_BELOW_PREVIOUS", "%s is below the last reading of %s on %s; mark it a meter replacement if the meter was changed.", Num(value), Num(last.Value), last.On)
	}
	if in.Purpose != "monthly" {
		if in.BookingID == nil || *in.BookingID == "" {
			return nil, 0, errs.Invalid("bookingId", "Pick the stay this reading belongs to.")
		}
		s := c.Stay
		if s == nil || !c.Serves(s.UnitID) {
			return nil, 0, errs.Invalid("bookingId", "Pick a stay of this meter's unit.")
		}
		if nights := c.Nights(s.CheckIn, s.CheckOut); nights < c.LongStayNights {
			return nil, 0, errs.Newf("READING_SHORT_STAY", "%s is %d nights; check-in and check-out readings are for stays of %d nights or more.", s.Code, nights, c.LongStayNights)
		}
		has := func(purpose string) bool {
			return slices.ContainsFunc(c.Readings, func(r MeterReading) bool {
				return r.BookingID != nil && *r.BookingID == s.ID && r.Purpose == purpose
			})
		}
		if has(in.Purpose) {
			return nil, 0, errs.Newf("READING_TWICE", "%s already has a %s reading on %s.", s.Code, purposeWord(in.Purpose), m.Number)
		}
		if in.Purpose == "check_out" {
			if !has("check_in") {
				return nil, 0, errs.Newf("READING_NO_CHECK_IN", "Record the check-in reading of %s on %s first.", s.Code, m.Number)
			}
			if m.Payer == "guest" && s.Status != "checked_in" {
				return nil, 0, errs.Newf("READING_STAY_CLOSED", "%s has checked out; take the check-out reading while the guest is in house.", s.Code)
			}
		}
	}
	if last == nil {
		return nil, 0, nil
	}
	prev := last.Value
	if in.Replacement {
		return &prev, 0, nil
	}
	return &prev, Round2(value - prev), nil
}

// UtilityBill is what a reading bills.
type UtilityBill struct {
	Payer  string
	Usage  float64
	Amount int64
}

// ReadingBill is readingBill: a guest-paid check-out bills the usage since the stay's check-in
// reading, an owner-paid monthly reading its consumption. earlier are the meter's readings before
// this one, in the order they were recorded.
func ReadingBill(m Meter, r MeterReading, earlier []MeterReading) *UtilityBill {
	var usage float64
	switch {
	case m.Payer == "guest" && r.Purpose == "check_out" && r.BookingID != nil:
		start := slices.IndexFunc(earlier, func(x MeterReading) bool {
			return x.BookingID != nil && *x.BookingID == *r.BookingID && x.Purpose == "check_in"
		})
		if start < 0 {
			return nil
		}
		for _, x := range earlier[start+1:] {
			usage += x.Consumption
		}
		usage = Round2(usage + r.Consumption)
	case m.Payer == "owner" && r.Purpose == "monthly":
		usage = r.Consumption
	default:
		return nil
	}
	amount := int64(math.Round(usage * float64(m.Tariff)))
	if amount <= 0 {
		return nil
	}
	return &UtilityBill{Payer: m.Payer, Usage: usage, Amount: amount}
}

// UtilityDescription is utilityDescription.
func UtilityDescription(m Meter, usage float64) string {
	return fmt.Sprintf("%s %s %s at %d per %s, meter %s", MeterKindLabel[m.Kind], Num(usage), m.Unit, m.Tariff, m.Unit, m.Number)
}
