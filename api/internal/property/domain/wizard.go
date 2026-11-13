package domain

import (
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// WizardRoom is a room in the New property wizard; its room type is an index into the wizard's
// groups, or nil to sell the room on its own.
type WizardRoom struct {
	Code         string         `json:"code"`
	Name         string         `json:"name"`
	Bedrooms     float64        `json:"bedrooms"`
	NightlyRate  float64        `json:"nightlyRate"`
	GroupIndex   *int           `json:"groupIndex"`
	Amenities    []string       `json:"amenities"`
	Plan         *RatePlanInput `json:"plan,omitempty"`
	MaxAdults    *float64       `json:"maxAdults"`
	MaxChildren  *float64       `json:"maxChildren"`
	Beds         []Bed          `json:"beds"`
	SizeSqm      *float64       `json:"sizeSqm"`
	View         string         `json:"view"`
	ExtraBeds    float64        `json:"extraBeds"`
	ExtraBedRate float64        `json:"extraBedRate"`
	Photos       []Photo        `json:"photos"`
	Floor        string         `json:"floor"`
}

// Unit is the unit form the room makes in the villa, sold under the room type group.
func (r WizardRoom) Unit(villaID string, group *string) UnitInput {
	return UnitInput{
		VillaID: villaID, GroupID: group, Code: r.Code, Name: r.Name, Bedrooms: r.Bedrooms, NightlyRate: r.NightlyRate,
		Status: UnitActive, Amenities: r.Amenities, MaxAdults: r.MaxAdults, MaxChildren: r.MaxChildren, Beds: r.Beds,
		SizeSqm: r.SizeSqm, View: r.View, ExtraBeds: r.ExtraBeds, ExtraBedRate: r.ExtraBedRate, Photos: r.Photos, Floor: r.Floor,
	}
}

// WizardGroup is a shared room type in the wizard. An empty kind takes the property's default; a
// room type of rooms is interchangeable and sold by room type unless the form says otherwise.
// MinStay left out is the kind's default (DefaultMinStay).
type WizardGroup struct {
	Name            string         `json:"name"`
	Interchangeable *bool          `json:"interchangeable"`
	OperatorAssigns *bool          `json:"operatorAssigns"`
	Kind            string         `json:"kind"`
	MinStay         *float64       `json:"minStay"`
	Plan            *RatePlanInput `json:"plan,omitempty"`
}

// MaxMinStay is the longest minimum stay in nights a room type may start with.
const MaxMinStay = 90

// minStay is the group's starting minimum stay in a property that operates as operation.
func (g WizardGroup) minStay(operation string) int {
	if g.MinStay != nil {
		return int(*g.MinStay)
	}
	return DefaultMinStay(g.kind(operation))
}

// kind is the group's kind in a property that operates as operation.
func (g WizardGroup) kind(operation string) string {
	return GroupInput{Kind: g.Kind}.WithKind("", operation).Kind
}

// flags are the group's interchangeable and operator assigns, defaulted from its kind.
func (g WizardGroup) flags(operation string) (interchangeable, operatorAssigns bool) {
	rooms := g.kind(operation) == KindRoom
	interchangeable, operatorAssigns = rooms, rooms
	if g.Interchangeable != nil {
		interchangeable = *g.Interchangeable
	}
	if g.OperatorAssigns != nil {
		operatorAssigns = *g.OperatorAssigns
	}
	return interchangeable, operatorAssigns && interchangeable
}

// PropertyInput is everything the wizard saves in one go.
type PropertyInput struct {
	Villa  VillaInput    `json:"villa"`
	Groups []WizardGroup `json:"groups"`
	Rooms  []WizardRoom  `json:"rooms"`
}

// WizardType is a room type the wizard creates: key g0 for a shared type, r2 for a room's own.
type WizardType struct {
	Key             string
	Name            string
	Interchangeable bool
	OperatorAssigns bool
	Kind            string
	MinStay         int
	Plan            RatePlanInput
	Rooms           []int
}

// operation is the property's operation as the wizard sends it, villa when left out.
func (in PropertyInput) operation() string {
	if in.Villa.Operation == "" {
		return OperationVilla
	}
	return in.Villa.Operation
}

// villaUnits counts the rooms of villa kind the wizard creates.
func (in PropertyInput) villaUnits() int {
	n := 0
	for _, t := range WizardTypes(in) {
		if t.Kind == KindVilla {
			n += len(t.Rooms)
		}
	}
	return n
}

// WizardTypes is wizardTypes: each shared type, then one of its own for every room without one,
// so every type carries a rate plan. A missing plan starts from the type's first room's base price.
func WizardTypes(in PropertyInput) []WizardType {
	firstRate := 0.0
	if len(in.Rooms) > 0 {
		firstRate = in.Rooms[0].NightlyRate
	}
	var out []WizardType
	for i, g := range in.Groups {
		var rooms []int
		for j, r := range in.Rooms {
			if r.GroupIndex != nil && *r.GroupIndex == i {
				rooms = append(rooms, j)
			}
		}
		base := firstRate
		if len(rooms) > 0 {
			base = in.Rooms[rooms[0]].NightlyRate
		}
		plan := DefaultRatePlan(base)
		if g.Plan != nil {
			plan = *g.Plan
		}
		interchangeable, operatorAssigns := g.flags(in.operation())
		out = append(out, WizardType{Key: fmt.Sprintf("g%d", i), Name: strings.TrimSpace(g.Name), Interchangeable: interchangeable, OperatorAssigns: operatorAssigns,
			Kind: g.kind(in.operation()), MinStay: g.minStay(in.operation()), Plan: plan, Rooms: rooms})
	}
	for j, r := range in.Rooms {
		if r.GroupIndex != nil {
			continue
		}
		plan := DefaultRatePlan(r.NightlyRate)
		if r.Plan != nil {
			plan = *r.Plan
		}
		kind := DefaultKind(in.operation())
		out = append(out, WizardType{Key: fmt.Sprintf("r%d", j), Name: strings.TrimSpace(r.Name), Kind: kind, MinStay: DefaultMinStay(kind), Plan: plan, Rooms: []int{j}})
	}
	return out
}

// ValidateProperty is validateProperty. villaCodeTaken says another villa has the code; taken
// says whether a unit code is already used.
func ValidateProperty(in PropertyInput, villaCodeTaken bool, taken func(code string) bool) error {
	var f errs.Fields
	for _, e := range villaFields(in.Villa, villaCodeTaken) {
		f.Add("villa."+e.Field, e.Message)
	}
	mismatch := false
	for i, g := range in.Groups {
		if short(g.Name) {
			f.Add(fmt.Sprintf("groups.%d.name", i), "Enter the room type name.")
		}
		if kindFields(g.kind(in.operation()), in.operation(), fmt.Sprintf("groups.%d.kind", i), &f) {
			mismatch = true
		}
		if m := g.MinStay; m != nil && (!whole(*m) || *m < 1 || *m > MaxMinStay) {
			f.Add(fmt.Sprintf("groups.%d.minStay", i), fmt.Sprintf("A minimum stay is 1 to %d nights.", MaxMinStay))
		}
	}
	if w := in.Villa.WholeRental; w != nil && *w && in.villaUnits() < 2 {
		f.Add("villa.wholeRental", "Renting the whole property needs at least two villas.")
	}
	if len(in.Rooms) == 0 {
		f.Add("rooms", "Add at least one room.")
	}
	seen := map[string]bool{}
	for i, r := range in.Rooms {
		key := fmt.Sprintf("rooms.%d.", i)
		switch {
		case !unitCode.MatchString(r.Code):
			f.Add(key+"code", "Code is the villa code, a dash and two to four digits.")
		case in.Villa.Code != "" && !strings.HasPrefix(r.Code, in.Villa.Code+"-"):
			f.Add(key+"code", fmt.Sprintf("Code must start with %s-.", in.Villa.Code))
		case seen[r.Code]:
			f.Add(key+"code", fmt.Sprintf("%s is listed twice.", r.Code))
		case taken(r.Code):
			f.Add(key+"code", fmt.Sprintf("%s is already used.", r.Code))
		}
		seen[r.Code] = true
		if short(r.Name) {
			f.Add(key+"name", "Enter the room name.")
		}
		if !whole(r.Bedrooms) || r.Bedrooms < 1 {
			f.Add(key+"bedrooms", "At least one bedroom.")
		}
		if !whole(r.NightlyRate) || r.NightlyRate <= 0 {
			f.Add(key+"nightlyRate", "Enter the nightly rate.")
		}
		if r.GroupIndex != nil && (*r.GroupIndex < 0 || *r.GroupIndex >= len(in.Groups)) {
			f.Add(key+"groupIndex", "Pick a room type from the list.")
		}
		var room errs.Fields
		capacityFields(r.Unit("", nil), &room)
		for _, e := range room {
			f.Add(key+e.Field, e.Message)
		}
		floorFields(r.Floor, key+"floor", &f)
	}

	for _, t := range WizardTypes(in) {
		rateFields(t.Plan, "plans."+t.Key+".", &f)
	}
	return kindErr(f, mismatch)
}
