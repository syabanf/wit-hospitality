package domain

import (
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Package rates: how a rate package prices the room night.
const (
	PackagePlan    = "plan"
	PackageFixed   = "fixed"
	PackagePercent = "percent"
)

// Move rates: what a room move does with the nightly prices.
const (
	MoveKeep    = "keep"
	MoveReprice = "reprice"
)

// RatePackage is a rate package of a hotel room type's rate plan, and the copy a stay keeps of
// the one it was sold on. Rate plan sells at the plan's nightly rate, fixed at Value rupiah every
// night, percent at the plan's rate less Value percent. Breakfast is rupiah per person per night;
// AccountID ties a corporate rate to a city ledger account.
type RatePackage struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Rate      string  `json:"rate"`
	Value     int64   `json:"value"`
	Breakfast int64   `json:"breakfast"`
	AccountID *string `json:"accountId"`
}

// Package looks a package up on the plan.
func (p RatePlan) Package(id string) (RatePackage, bool) {
	for _, k := range p.Packages {
		if k.ID == id {
			return k, true
		}
	}
	return RatePackage{}, false
}

// PackageNight is packageNight: a rate plan night through the stay's package. A night no rate
// plan priced, or a stay without a package, stays as it is.
func PackageNight(pkg *RatePackage, n NightPrice) NightPrice {
	if pkg == nil || n.Source.Kind != "plan" {
		return n
	}
	switch pkg.Rate {
	case PackageFixed:
		n.Rate, n.Source.Name = pkg.Value, pkg.Name
	case PackagePercent:
		n.Rate, n.Source.Name = jsRound(float64(n.Rate)*float64(100-pkg.Value)/100), n.Source.Name+", "+pkg.Name
	default:
		n.Source.Name = n.Source.Name + ", " + pkg.Name
	}
	return n
}

// PackageFor is the package a new stay is sold on, in the contract's order: PACKAGE_NOT_ALLOWED
// on a channel stay or a villa-kind unit, PACKAGE_UNKNOWN when the room type's plan has none by
// that id, PACKAGE_ACCOUNT when a corporate rate is not billed to its account. billedTo is the
// city ledger account the booking bills, or "".
func PackageFor(c Catalog, unit Unit, source, packageID, billedTo string) (*RatePackage, error) {
	if packageID == "" {
		return nil, nil
	}
	if source != Direct || c.UnitKind(unit) != KindRoom {
		return nil, errs.New("PACKAGE_NOT_ALLOWED", "A rate package is for a direct stay in a hotel room.")
	}
	name := unit.Code
	if g, ok := c.Group(unit.Group()); ok {
		name = g.Name
	}
	plan, _ := c.Plan(unit.Group())
	pkg, ok := plan.Package(packageID)
	if !ok {
		return nil, errs.Newf("PACKAGE_UNKNOWN", "%s has no such rate package.", name)
	}
	if pkg.AccountID != nil && *pkg.AccountID != "" && *pkg.AccountID != billedTo {
		return nil, errs.Newf("PACKAGE_ACCOUNT", "%s is a company rate; bill the stay to its city ledger account.", pkg.Name)
	}
	return &pkg, nil
}

// moveCandidate reports a unit a stay in current may move to, whatever its status: a unit of the
// same interchangeable room type, or for a hotel room any other room of the same property.
func moveCandidate(c Catalog, current, target Unit) bool {
	if target.ID == current.ID {
		return false
	}
	if g, ok := c.GroupOf(current.ID); ok && g.Interchangeable && target.Group() == g.ID {
		return true
	}
	return c.UnitKind(current) == KindRoom && c.UnitKind(target) == KindRoom && target.VillaID == current.VillaID
}

// MoveTargets is where a stay in unitID may move: the active interchangeable units, and for a
// hotel room every other active room of the same property, whatever its room type.
func MoveTargets(c Catalog, unitID string) []Unit {
	current, ok := c.Unit(unitID)
	if !ok {
		return nil
	}
	var out []Unit
	for _, u := range c.Units {
		if u.Status == "active" && moveCandidate(c, current, u) {
			out = append(out, u)
		}
	}
	return out
}

// CheckMoveTarget refuses a move the rules do not allow: UNIT_NOT_INTERCHANGEABLE for a unit
// outside the stay's reach, UNIT_UNAVAILABLE for one inside it that is not active.
func CheckMoveTarget(c Catalog, current, target Unit) error {
	if !moveCandidate(c, current, target) {
		return ErrNotInterchangeable(fmt.Sprintf("%s is not interchangeable with %s.", target.Code, current.Code))
	}
	if target.Status != "active" {
		return errs.Newf("UNIT_UNAVAILABLE", "%s is %s.", target.Code, target.Status)
	}
	return nil
}

// RepriceFrom is the first night a move with rate "reprice" prices again: the nights the audit
// posted and the nights before today keep their price.
func RepriceFrom(b Booking, today string) int {
	posted := 0
	if b.NightsPosted != nil {
		posted = len(*b.NightsPosted)
	}
	return max(posted, DaysBetween(b.CheckIn, today), 0)
}
