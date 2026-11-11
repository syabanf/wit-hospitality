package domain

import (
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// WizardRoom is a room in the New property wizard; its room type is an index into the wizard's
// groups, or nil to sell the room on its own.
type WizardRoom struct {
	Code        string         `json:"code"`
	Name        string         `json:"name"`
	Bedrooms    float64        `json:"bedrooms"`
	NightlyRate float64        `json:"nightlyRate"`
	GroupIndex  *int           `json:"groupIndex"`
	Amenities   []string       `json:"amenities"`
	Plan        *RatePlanInput `json:"plan,omitempty"`
}

// WizardGroup is a shared room type in the wizard.
type WizardGroup struct {
	Name            string         `json:"name"`
	Interchangeable bool           `json:"interchangeable"`
	OperatorAssigns bool           `json:"operatorAssigns"`
	Plan            *RatePlanInput `json:"plan,omitempty"`
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
	Plan            RatePlanInput
	Rooms           []int
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
		out = append(out, WizardType{Key: fmt.Sprintf("g%d", i), Name: strings.TrimSpace(g.Name), Interchangeable: g.Interchangeable, OperatorAssigns: g.OperatorAssigns && g.Interchangeable, Plan: plan, Rooms: rooms})
	}
	for j, r := range in.Rooms {
		if r.GroupIndex != nil {
			continue
		}
		plan := DefaultRatePlan(r.NightlyRate)
		if r.Plan != nil {
			plan = *r.Plan
		}
		out = append(out, WizardType{Key: fmt.Sprintf("r%d", j), Name: strings.TrimSpace(r.Name), Plan: plan, Rooms: []int{j}})
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
	for i, g := range in.Groups {
		if short(g.Name) {
			f.Add(fmt.Sprintf("groups.%d.name", i), "Enter the room type name.")
		}
	}
	if len(in.Rooms) == 0 {
		f.Add("rooms", "Add at least one room.")
	}
	seen := map[string]bool{}
	for i, r := range in.Rooms {
		key := fmt.Sprintf("rooms.%d.", i)
		switch {
		case !unitCode.MatchString(r.Code):
			f.Add(key+"code", "Code is the villa code, a dash and two digits.")
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
	}
	for _, t := range WizardTypes(in) {
		rateFields(t.Plan, "plans."+t.Key+".", &f)
	}
	return f.Err()
}
