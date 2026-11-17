package domain

import (
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
	"github.com/syabanf/wit-hospitality/api/internal/property"
)

// How a package prices the room night.
const (
	PackagePlan    = "plan"
	PackageFixed   = "fixed"
	PackagePercent = "percent"
)

// MaxPackages is MAX_PACKAGES.
const MaxPackages = 12

// RoomOnly is the package every stay without one has; it is never stored.
const RoomOnly = "Room only"

// RatePackage is one way a hotel room type sells beside Room only: the plan's rate, a fixed
// nightly price or a percent off, with breakfast per person per night, and for a corporate rate
// the city ledger account of the company it belongs to.
type RatePackage struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Rate      string  `json:"rate"`
	Value     int64   `json:"value"`
	Breakfast int64   `json:"breakfast"`
	AccountID *string `json:"accountId"`
}

// PackageInput is a package from the form, numbers unchecked. A package without an id is new.
type PackageInput struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Rate      string  `json:"rate"`
	Value     float64 `json:"value"`
	Breakfast float64 `json:"breakfast"`
	AccountID *string `json:"accountId"`
}

func (in PackageInput) account() string {
	if in.AccountID == nil {
		return ""
	}
	return strings.TrimSpace(*in.AccountID)
}

// packageFields is validateRatePackages. kind is the room type's; company reports whether an id is
// a city ledger account of kind company, nil when nothing here can tell.
func packageFields(pkgs []PackageInput, kind string, company func(id string) (bool, error), f *errs.Fields) error {
	if len(pkgs) > MaxPackages {
		f.Add("packages", fmt.Sprintf("Keep at most %d packages.", MaxPackages))
	}
	if len(pkgs) > 0 && kind != KindRoom {
		f.Add("packages", "Packages are for hotel room types; a villa sells at its own price.")
	}
	seen := []string{}
	for i, p := range pkgs {
		key := fmt.Sprintf("packages.%d.", i)
		name := strings.TrimSpace(p.Name)
		lower := strings.ToLower(name)
		switch {
		case utf8.RuneCountInString(name) < 2:
			f.Add(key+"name", "Name the package.")
		case lower == strings.ToLower(RoomOnly):
			f.Add(key+"name", "Room only is always offered; name this one differently.")
		case slices.Contains(seen, lower):
			f.Add(key+"name", fmt.Sprintf("%s is listed twice.", name))
		}
		seen = append(seen, lower)
		switch p.Rate {
		case PackagePlan:
		case PackageFixed:
			if !whole(p.Value) || p.Value <= 0 {
				f.Add(key+"value", "Enter the nightly price in whole rupiah.")
			}
		case PackagePercent:
			if !whole(p.Value) || p.Value < 1 || p.Value > 90 {
				f.Add(key+"value", "A whole percentage from 1 to 90.")
			}
		default:
			f.Add(key+"rate", "Pick how the room is priced.")
		}
		switch {
		case !whole(p.Breakfast) || p.Breakfast < 0:
			f.Add(key+"breakfast", "Enter the breakfast price per person in whole rupiah, or zero.")
		case p.Rate == PackagePlan && p.Breakfast == 0:
			f.Add(key+"breakfast", "Add breakfast or a rate; without either this is Room only.")
		}
		if id := p.account(); id != "" && company != nil {
			ok, err := company(id)
			if err != nil {
				return err
			}
			if !ok {
				f.Add(key+"accountId", "Pick a company account from the city ledger.")
			}
		}
	}
	return nil
}

// ValidatePackages is validateRatePackages for a room type of kind; see packageFields.
func ValidatePackages(pkgs []PackageInput, kind string, company func(id string) (bool, error)) error {
	var f errs.Fields
	if err := packageFields(pkgs, kind, company, &f); err != nil {
		return err
	}
	return f.Err()
}

// Packages turns valid forms into the plan's packages: names trimmed, a plan rate's value 0, and a
// package without an id named pkg-<slug of the name>, with -2, -3 on a clash inside the plan.
func Packages(in []PackageInput) []RatePackage {
	out := make([]RatePackage, 0, len(in))
	taken := map[string]bool{}
	for _, p := range in {
		if p.ID != "" {
			taken[p.ID] = true
		}
	}
	for _, p := range in {
		pkg := RatePackage{ID: p.ID, Name: strings.TrimSpace(p.Name), Rate: p.Rate, Value: int64(p.Value), Breakfast: int64(p.Breakfast)}
		if pkg.Rate == PackagePlan {
			pkg.Value = 0
		}
		if id := p.account(); id != "" {
			pkg.AccountID = &id
		}
		if pkg.ID == "" {
			slug := ids.Slug(pkg.Name)
			if slug == "" {
				slug = "x"
			}
			pkg.ID = "pkg-" + slug
			for n := 2; taken[pkg.ID]; n++ {
				pkg.ID = fmt.Sprintf("pkg-%s-%d", slug, n)
			}
			taken[pkg.ID] = true
		}
		out = append(out, pkg)
	}
	return out
}

// PlanState is the plan as its event carries it.
func PlanState(p RatePlan) property.RatePlan {
	out := property.RatePlan{GroupID: p.GroupID, WeekdayRate: p.WeekdayRate, WeekendRate: p.WeekendRate, Seasons: []property.Season{}, Packages: []property.RatePackage{}}
	for _, s := range p.Seasons {
		out.Seasons = append(out.Seasons, property.Season{Name: s.Name, From: s.From, To: s.To, Kind: s.Kind, Value: s.Value})
	}
	for _, k := range p.Packages {
		out.Packages = append(out.Packages, property.RatePackage{ID: k.ID, Name: k.Name, Rate: k.Rate, Value: k.Value, Breakfast: k.Breakfast, AccountID: k.AccountID})
	}
	return out
}
