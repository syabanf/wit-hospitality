package domain

import (
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Whole villa refusals.
const (
	CodeWholeVillaNotAllowed  = "WHOLE_VILLA_NOT_ALLOWED"
	CodeWholeVillaUnavailable = "WHOLE_VILLA_UNAVAILABLE"
)

// WholeVillaPlan names the price source of a night priced from the villa's whole nightly rate.
const WholeVillaPlan = "Whole villa"

// WholeVillaUnits are the villa's villa-kind units that are not inactive, in catalog order: what a
// whole villa booking takes.
func WholeVillaUnits(c Catalog, villaID string) []Unit {
	var out []Unit
	for _, u := range c.Units {
		if u.VillaID == villaID && u.Status != "inactive" && c.UnitKind(u) == KindVilla {
			out = append(out, u)
		}
	}
	return out
}

// CheckWholeRental refuses a villa that is not rented whole, a hotel, or one without villa units.
func CheckWholeRental(v Villa, units []Unit) error {
	if !v.WholeRental || v.Operation == OperationHotel {
		return errs.Newf(CodeWholeVillaNotAllowed, "%s is not rented whole.", v.Name)
	}
	if len(units) == 0 {
		return errs.Newf(CodeWholeVillaNotAllowed, "%s has no villa to rent whole.", v.Name)
	}
	return nil
}

// CheckWholeVillaFree refuses the stay when a unit is booked, blocked or out of service on any of
// its nights. A stay booked by room type counts against the unit it holds.
func CheckWholeVillaFree(v Villa, units []Unit, checkIn, checkOut string, held []Holding, blocks []UnitBlock) error {
	var taken []string
	for _, u := range units {
		busy := u.Status == "maintenance" || len(FindConflicts(u.ID, checkIn, checkOut, held, blocks, "")) > 0
		for _, h := range held {
			busy = busy || (h.UnitID == u.ID && !h.UnitAssigned && Occupies(h.Status) && Overlaps(h.CheckIn, h.CheckOut, checkIn, checkOut))
		}
		if busy {
			taken = append(taken, u.Code)
		}
	}
	if len(taken) > 0 {
		return errs.Newf(CodeWholeVillaUnavailable, "%s has %s taken on those nights.", v.Name, strings.Join(taken, ", "))
	}
	return nil
}

// WholeVillaCapacity is what the units sleep together: each number summed. ok is false when a
// unit's capacity is unknown, and then the rule does not apply.
func WholeVillaCapacity(v Villa, units []Unit) (Capacity, bool) {
	out := Capacity{Name: v.Name}
	for _, u := range units {
		c, ok := UnitCapacity(u)
		if !ok {
			return out, false
		}
		out.MaxAdults += c.MaxAdults
		out.MaxChildren += c.MaxChildren
		out.ExtraBeds += c.ExtraBeds
	}
	return out, true
}

// SpreadParty places the party over the units in order, each unit taking as many adults as it
// sleeps and then children into its free beds; a unit left empty gets nil. When the party fits
// the summed capacity, every unit's share fits that unit. A unit of unknown capacity takes the
// rest.
func SpreadParty(units []Unit, adults, children int) []*PartySize {
	out := make([]*PartySize, len(units))
	for i, u := range units {
		a, c := adults, children
		if room, ok := UnitCapacity(u); ok {
			a = min(adults, room.MaxAdults+room.ExtraBeds)
			c = min(children, room.MaxAdults+room.MaxChildren+room.ExtraBeds-a)
		}
		if a+c > 0 {
			out[i] = &PartySize{Adults: a, Children: c}
		}
		adults, children = adults-a, children-c
	}
	return out
}

// SplitNightly shares a nightly price evenly over n stays, the remainder on the first.
func SplitNightly(total int64, n int) []int64 {
	if n <= 0 {
		return nil
	}
	out := make([]int64, n)
	share := total / int64(n)
	for i := range out {
		out[i] = share
	}
	out[0] += total - share*int64(n)
	return out
}

// WholePrice is a staff price for the whole villa a night, with the reason.
type WholePrice struct {
	Nightly float64 `json:"nightly"`
	Reason  string  `json:"reason"`
}

// WholeVillaFields checks the whole villa form, keyed as the form names its fields.
func WholeVillaFields(villaID string, hasGuest bool, checkIn, checkOut string, adults, children float64, source string, price *WholePrice) errs.Fields {
	var f errs.Fields
	if villaID == "" {
		f.Add("villaId", "Pick the villa.")
	}
	if !hasGuest {
		f.Add("guestId", "Pick the lead guest or add a new one.")
	}
	if msg := ValidateStay(checkIn, checkOut); msg != "" {
		f.Add("checkOut", msg)
	}
	if !whole(adults) || adults < 1 {
		f.Add("adults", "At least one adult.")
	}
	if !whole(children) || children < 0 {
		f.Add("children", "Children cannot be negative.")
	}
	if source != Direct && source != Airbnb {
		f.Add("source", "Pick direct or Airbnb.")
	}
	if price != nil {
		if !whole(price.Nightly) || price.Nightly <= 0 {
			f.Add("price.nightly", "Enter the nightly price in whole rupiah.")
		}
		if len([]rune(strings.TrimSpace(price.Reason))) < 3 {
			f.Add("price.reason", "Say why the price changes.")
		}
	}
	return f
}
