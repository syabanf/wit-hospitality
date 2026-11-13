package domain

import (
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Capacity is how many guests a unit, or every unit of a room type, sleeps.
type Capacity struct {
	Name        string
	MaxAdults   int
	MaxChildren int
	ExtraBeds   int
}

// Fits is the capacity rule: adults <= maxAdults + extraBeds and adults + children <= maxAdults +
// maxChildren + extraBeds.
func (c Capacity) Fits(adults, children int) bool {
	return adults <= c.MaxAdults+c.ExtraBeds && adults+children <= c.MaxAdults+c.MaxChildren+c.ExtraBeds
}

// Check refuses a party that does not fit with UNIT_CAPACITY. The extra beds are named only when
// there are some.
func (c Capacity) Check(adults, children int) error {
	if c.Fits(adults, children) {
		return nil
	}
	extra := ""
	if c.ExtraBeds > 0 {
		extra = ", plus " + count(c.ExtraBeds, "extra bed", "extra beds")
	}
	return errs.Newf("UNIT_CAPACITY", "%s sleeps %s and %s%s.", c.Name, count(c.MaxAdults, "adult", "adults"), count(c.MaxChildren, "child", "children"), extra)
}

func count(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

// UnitCapacity returns the unit's capacity; ok is false while it is unknown.
func UnitCapacity(u Unit) (Capacity, bool) {
	if u.MaxAdults == nil || u.MaxChildren == nil || u.ExtraBeds == nil {
		return Capacity{}, false
	}
	return Capacity{Name: u.Name, MaxAdults: *u.MaxAdults, MaxChildren: *u.MaxChildren, ExtraBeds: *u.ExtraBeds}, true
}

// GroupCapacity is the smallest capacity among the room type's units with a known capacity, each
// number taken on its own, named after the room type; ok is false when no unit's is known.
func GroupCapacity(c Catalog, g UnitGroup) (Capacity, bool) {
	out := Capacity{Name: g.Name}
	found := false
	for _, u := range c.Units {
		cu, ok := UnitCapacity(u)
		if !ok || u.Group() != g.ID {
			continue
		}
		if !found {
			out.MaxAdults, out.MaxChildren, out.ExtraBeds = cu.MaxAdults, cu.MaxChildren, cu.ExtraBeds
			found = true
			continue
		}
		out.MaxAdults, out.MaxChildren, out.ExtraBeds = min(out.MaxAdults, cu.MaxAdults), min(out.MaxChildren, cu.MaxChildren), min(out.ExtraBeds, cu.ExtraBeds)
	}
	return out, found
}

// Party is the guests on a stay: the front desk's count once checked in, else the size booked.
// ok is false when neither is known.
func (b Booking) Party() (adults, children int, ok bool) {
	if b.Arrival != nil {
		return int(b.Arrival.Adults), int(b.Arrival.Children), true
	}
	if b.PartySize != nil {
		return b.PartySize.Adults, b.PartySize.Children, true
	}
	return 0, 0, false
}

// CheckUnitFits refuses a party the unit cannot sleep; an unknown unit or capacity passes.
func CheckUnitFits(c Catalog, unitID string, adults, children int) error {
	u, ok := c.Unit(unitID)
	if !ok {
		return nil
	}
	room, ok := UnitCapacity(u)
	if !ok {
		return nil
	}
	return room.Check(adults, children)
}

// CheckGroupFits refuses a party the smallest room of the type cannot sleep.
func CheckGroupFits(c Catalog, g UnitGroup, adults, children int) error {
	room, ok := GroupCapacity(c, g)
	if !ok {
		return nil
	}
	return room.Check(adults, children)
}
