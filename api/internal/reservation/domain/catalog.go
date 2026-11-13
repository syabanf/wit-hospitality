// Package domain holds the reservation context's rules, ported from src/domain/booking.ts,
// group.ts, restriction.ts, overbooking.ts, pricing.ts, the rate plan pricing in ratePlan.ts, the
// cancellation terms in payment.ts, precheckin.ts and the booking adapter in
// src/infrastructure/mock. Validators return field errors in the TypeScript order with the same
// wording; refusals carry the same codes.
package domain

import (
	"strings"
	"time"
)

// Catalog is reservation's copy of the property catalog, kept from property events. Rules read
// units, room types and blocks from it, never from the property schema.
type Catalog struct {
	Locations []Location
	Villas    []Villa
	Groups    []UnitGroup
	Units     []Unit
	RatePlans []RatePlan
	Blocks    []UnitBlock
}

// Location is a location as reservation needs it.
type Location struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Villa is a villa as reservation needs it. The house times are empty until the copy has seen
// an event that carries them.
type Villa struct {
	ID           string `json:"id"`
	LocationID   string `json:"locationId"`
	Name         string `json:"name"`
	CheckInTime  string `json:"checkInTime"`
	CheckOutTime string `json:"checkOutTime"`
	// Operation is villa, hotel or mixed; WholeRental lets the villa be booked whole at
	// WholeNightlyRate a night (0 the sum of its villa units); DepositOnCheckIn asks a security
	// deposit at check-in.
	Operation        string `json:"operation"`
	WholeRental      bool   `json:"wholeRental"`
	WholeNightlyRate int64  `json:"wholeNightlyRate"`
	DepositOnCheckIn bool   `json:"depositOnCheckIn"`
}

// UnitGroup is a room type; Kind is room or villa.
type UnitGroup struct {
	ID              string `json:"id"`
	VillaID         string `json:"villaId"`
	Name            string `json:"name"`
	Interchangeable bool   `json:"interchangeable"`
	OperatorAssigns bool   `json:"operatorAssigns"`
	Kind            string `json:"kind"`
}

// Operations and unit kinds as property names them.
const (
	OperationHotel = "hotel"
	OperationMixed = "mixed"
	KindRoom       = "room"
	KindVilla      = "villa"
)

// UnitKind is the unit's kind: its room type's, or without one a room in a hotel and a villa
// otherwise. The business rules for rooms and villas key on it.
func (c Catalog) UnitKind(u Unit) string {
	if g, ok := c.Group(u.Group()); ok && g.Kind != "" {
		return g.Kind
	}
	if v, ok := c.Villa(u.VillaID); ok && v.Operation == OperationHotel {
		return KindRoom
	}
	return KindVilla
}

// DepositAsked is whether check-in into the unit asks a security deposit: the property's
// setting, applied to villa units only in a mixed property.
func (c Catalog) DepositAsked(u Unit) bool {
	v, ok := c.Villa(u.VillaID)
	if !ok || !v.DepositOnCheckIn {
		return false
	}
	return v.Operation != OperationMixed || c.UnitKind(u) == KindVilla
}

// Unit is a sellable room.
type Unit struct {
	ID          string  `json:"id"`
	VillaID     string  `json:"villaId"`
	GroupID     *string `json:"groupId"`
	Code        string  `json:"code"`
	Name        string  `json:"name"`
	NightlyRate int64   `json:"nightlyRate"`
	Status      string  `json:"status"`
	// Capacity from property; nil until the copy has seen it, and then the rule does not apply.
	MaxAdults   *int `json:"maxAdults,omitempty"`
	MaxChildren *int `json:"maxChildren,omitempty"`
	ExtraBeds   *int `json:"extraBeds,omitempty"`
}

// Group returns the unit's room type id, or "".
func (u Unit) Group() string {
	if u.GroupID == nil {
		return ""
	}
	return *u.GroupID
}

// UnitBlock holds a unit off sale; To is exclusive.
type UnitBlock struct {
	ID     string `json:"id"`
	UnitID string `json:"unitId"`
	From   string `json:"from"`
	To     string `json:"to"`
	Reason string `json:"reason"`
}

// Unit looks a unit up; ok is false when it is unknown.
func (c Catalog) Unit(id string) (Unit, bool) {
	for _, u := range c.Units {
		if u.ID == id {
			return u, true
		}
	}
	return Unit{}, false
}

// Group looks a room type up.
func (c Catalog) Group(id string) (UnitGroup, bool) {
	for _, g := range c.Groups {
		if g.ID == id {
			return g, true
		}
	}
	return UnitGroup{}, false
}

// Villa looks a villa up.
func (c Catalog) Villa(id string) (Villa, bool) {
	for _, v := range c.Villas {
		if v.ID == id {
			return v, true
		}
	}
	return Villa{}, false
}

// Location looks a location up.
func (c Catalog) Location(id string) (Location, bool) {
	for _, l := range c.Locations {
		if l.ID == id {
			return l, true
		}
	}
	return Location{}, false
}

// GroupOf returns the room type of a unit, when it has one.
func (c Catalog) GroupOf(unitID string) (UnitGroup, bool) {
	u, ok := c.Unit(unitID)
	if !ok || u.GroupID == nil {
		return UnitGroup{}, false
	}
	return c.Group(*u.GroupID)
}

// Plan returns the rate plan of a room type.
func (c Catalog) Plan(groupID string) (RatePlan, bool) {
	for _, p := range c.RatePlans {
		if p.GroupID == groupID {
			return p, true
		}
	}
	return RatePlan{}, false
}

// Dates are IsoDate strings, computed in UTC as lib/dates does.
const dateLayout = "2006-01-02"

func parse(d string) (time.Time, bool) {
	t, err := time.Parse(dateLayout, d)
	return t, err == nil
}

// AddDays shifts a date by n days.
func AddDays(d string, n int) string {
	t, ok := parse(d)
	if !ok {
		return d
	}
	return t.AddDate(0, 0, n).Format(dateLayout)
}

// DaysBetween counts days from a to b.
func DaysBetween(a, b string) int {
	ta, okA := parse(a)
	tb, okB := parse(b)
	if !okA || !okB {
		return 0
	}
	return int(tb.Sub(ta).Hours() / 24)
}

// EachDay lists the dates from from up to the day before to.
func EachDay(from, to string) []string {
	n := DaysBetween(from, to)
	out := make([]string, 0, max(n, 0))
	for i := 0; i < n; i++ {
		out = append(out, AddDays(from, i))
	}
	return out
}

// WeekdayIndex counts Monday as 0 through Sunday as 6.
func WeekdayIndex(d string) int {
	t, _ := parse(d)
	return (int(t.Weekday()) + 6) % 7
}

// ShortDay is "Nov 20".
func ShortDay(d string) string {
	t, ok := parse(d)
	if !ok {
		return d
	}
	return t.Format("Jan 2")
}

func shortDays(dates []string) string {
	out := make([]string, len(dates))
	for i, d := range dates {
		out[i] = ShortDay(d)
	}
	return strings.Join(out, ", ")
}

func spaced(status string) string { return strings.Replace(status, "_", " ", 1) }
