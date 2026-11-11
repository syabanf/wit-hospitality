// Package domain holds the property context's rules, ported from src/domain/property.ts,
// src/domain/ratePlan.ts and the property adapter in src/infrastructure/mock/index.ts. Validators
// return field errors in the TypeScript order with the same wording; refusals carry the same codes.
package domain

import (
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Location is a regency area that groups villas.
type Location struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Area    string `json:"area"`
	Version int64  `json:"-"`
}

// Villa is a property at a location.
type Villa struct {
	ID          string   `json:"id"`
	LocationID  string   `json:"locationId"`
	Code        string   `json:"code"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Facilities  []string `json:"facilities"`
	Version     int64    `json:"-"`
}

// UnitGroup is a room type: units with the same design.
type UnitGroup struct {
	ID              string `json:"id"`
	VillaID         string `json:"villaId"`
	Name            string `json:"name"`
	Interchangeable bool   `json:"interchangeable"`
	// OperatorAssigns: guests book the room type and the operator picks the unit.
	OperatorAssigns bool  `json:"operatorAssigns"`
	Version         int64 `json:"-"`
}

// Unit statuses.
const (
	UnitActive      = "active"
	UnitCleaning    = "cleaning"
	UnitMaintenance = "maintenance"
	UnitInactive    = "inactive"
)

// UnitStatuses is UNIT_STATUSES.
var UnitStatuses = []string{UnitActive, UnitCleaning, UnitMaintenance, UnitInactive}

// Unit is a sellable room.
type Unit struct {
	ID          string   `json:"id"`
	VillaID     string   `json:"villaId"`
	GroupID     *string  `json:"groupId"`
	Code        string   `json:"code"`
	Name        string   `json:"name"`
	Bedrooms    int      `json:"bedrooms"`
	NightlyRate int64    `json:"nightlyRate"`
	Status      string   `json:"status"`
	Amenities   []string `json:"amenities"`
	Version     int64    `json:"-"`
}

// Facility is a shared villa facility or an in-room amenity from the fixed lists.
type Facility struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// VillaFacilities is VILLA_FACILITIES.
var VillaFacilities = []Facility{
	{"pool", "Shared pool"}, {"wifi", "Wi-Fi"}, {"parking", "Parking"}, {"breakfast", "Breakfast"},
	{"restaurant", "Restaurant or café"}, {"spa", "Spa"}, {"gym", "Gym"}, {"kids", "Kids club"},
	{"shuttle", "Airport shuttle"}, {"security", "24-hour security"}, {"laundry", "Laundry service"}, {"garden", "Garden"},
}

// UnitAmenities is UNIT_AMENITIES.
var UnitAmenities = []Facility{
	{"ac", "Air conditioning"}, {"private-pool", "Private pool"}, {"kitchen", "Kitchen"}, {"bathtub", "Bathtub"},
	{"balcony", "Balcony or terrace"}, {"tv", "Smart TV"}, {"safe", "Safe"}, {"minibar", "Minibar"},
	{"workspace", "Workspace"}, {"outdoor-shower", "Outdoor shower"},
}

// LocationInput is the location form.
type LocationInput struct {
	Name string `json:"name"`
	Area string `json:"area"`
}

// VillaInput is the villa form.
type VillaInput struct {
	LocationID  string   `json:"locationId"`
	Code        string   `json:"code"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Facilities  []string `json:"facilities"`
}

// GroupInput is the room type form.
type GroupInput struct {
	VillaID         string `json:"villaId"`
	Name            string `json:"name"`
	Interchangeable bool   `json:"interchangeable"`
	OperatorAssigns bool   `json:"operatorAssigns"`
}

// UnitInput is the unit form. Numbers arrive as JSON numbers and are checked for whole values.
type UnitInput struct {
	VillaID     string   `json:"villaId"`
	GroupID     *string  `json:"groupId"`
	Code        string   `json:"code"`
	Name        string   `json:"name"`
	Bedrooms    float64  `json:"bedrooms"`
	NightlyRate float64  `json:"nightlyRate"`
	Status      string   `json:"status"`
	Amenities   []string `json:"amenities"`
}

var (
	villaCode = regexp.MustCompile(`^[A-Z]{2,4}$`)
	unitCode  = regexp.MustCompile(`^[A-Z]{2,4}-\d{2}$`)
)

func short(s string) bool { return utf8.RuneCountInString(strings.TrimSpace(s)) < 2 }

// whole is Number.isInteger.
func whole(f float64) bool { return !math.IsInf(f, 0) && !math.IsNaN(f) && f == math.Trunc(f) }

func list(s []string) []string {
	if s == nil {
		return []string{}
	}
	return slices.Clone(s)
}

// ValidateLocation is validateLocation.
func ValidateLocation(in LocationInput) error {
	var f errs.Fields
	if short(in.Name) {
		f.Add("name", "Enter the location name.")
	}
	if short(in.Area) {
		f.Add("area", `Enter the regency and island, for example "Badung, Bali".`)
	}
	return f.Err()
}

// NewLocation builds a location from a valid form.
func NewLocation(id string, in LocationInput) Location {
	return Location{ID: id, Name: strings.TrimSpace(in.Name), Area: strings.TrimSpace(in.Area)}
}

// Apply copies a valid form.
func (l *Location) Apply(in LocationInput) {
	l.Name, l.Area = strings.TrimSpace(in.Name), strings.TrimSpace(in.Area)
}

// villaFields is validateVilla without the prefix; codeTaken says another villa has the code.
func villaFields(in VillaInput, codeTaken bool) errs.Fields {
	var f errs.Fields
	if in.LocationID == "" {
		f.Add("locationId", "Pick the location.")
	}
	if !villaCode.MatchString(in.Code) {
		f.Add("code", "A villa code is two to four capital letters, for example SK.")
	} else if codeTaken {
		f.Add("code", fmt.Sprintf("%s is already used.", in.Code))
	}
	if short(in.Name) {
		f.Add("name", "Enter the villa name.")
	}
	return f
}

// ValidateVilla is validateVilla.
func ValidateVilla(in VillaInput, codeTaken bool) error { return villaFields(in, codeTaken).Err() }

// NewVilla builds a villa from a valid form.
func NewVilla(id string, in VillaInput) Villa {
	v := Villa{ID: id}
	v.Apply(in)
	return v
}

// Apply copies a valid form, trimming the name and description.
func (v *Villa) Apply(in VillaInput) {
	v.LocationID, v.Code = in.LocationID, in.Code
	v.Name, v.Description = strings.TrimSpace(in.Name), strings.TrimSpace(in.Description)
	v.Facilities = list(in.Facilities)
}

// ValidateGroup is validateGroup.
func ValidateGroup(in GroupInput) error {
	var f errs.Fields
	if in.VillaID == "" {
		f.Add("villaId", "Pick the villa.")
	}
	if short(in.Name) {
		f.Add("name", "Enter the group name.")
	}
	if in.OperatorAssigns && !in.Interchangeable {
		f.Add("operatorAssigns", "Only identical, interchangeable rooms can be sold as a room type.")
	}
	return f.Err()
}

// NewGroup builds a room type from a valid form.
func NewGroup(id string, in GroupInput) UnitGroup {
	g := UnitGroup{ID: id}
	g.Apply(in)
	return g
}

// Apply copies a valid form.
func (g *UnitGroup) Apply(in GroupInput) {
	g.VillaID, g.Name, g.Interchangeable, g.OperatorAssigns = in.VillaID, strings.TrimSpace(in.Name), in.Interchangeable, in.OperatorAssigns
}

// ValidateUnit is validateUnit. codeTaken says another unit has the code; group is the chosen room
// type, nil when none was chosen or it does not exist.
func ValidateUnit(in UnitInput, codeTaken bool, group *UnitGroup) error {
	var f errs.Fields
	if in.VillaID == "" {
		f.Add("villaId", "Pick the villa.")
	}
	if !unitCode.MatchString(in.Code) {
		f.Add("code", "A unit code is the villa code, a dash and two digits, for example SK-09.")
	} else if codeTaken {
		f.Add("code", fmt.Sprintf("%s is already used.", in.Code))
	}
	if short(in.Name) {
		f.Add("name", "Enter the unit name.")
	}
	if !whole(in.Bedrooms) || in.Bedrooms < 1 {
		f.Add("bedrooms", "At least one bedroom.")
	}
	if !whole(in.NightlyRate) || in.NightlyRate <= 0 {
		f.Add("nightlyRate", "Enter the nightly rate in whole rupiah.")
	}
	if in.GroupID != nil && *in.GroupID != "" && (group == nil || group.VillaID != in.VillaID) {
		f.Add("groupId", "The group belongs to another villa.")
	}
	if !slices.Contains(UnitStatuses, in.Status) {
		f.Add("status", "Pick a status.")
	}
	return f.Err()
}

// NewUnit builds a unit from a valid form.
func NewUnit(id string, in UnitInput) Unit {
	u := Unit{ID: id}
	u.Apply(in)
	return u
}

// Apply copies a valid form.
func (u *Unit) Apply(in UnitInput) {
	u.VillaID, u.Code, u.Name = in.VillaID, in.Code, strings.TrimSpace(in.Name)
	u.GroupID = nil
	if in.GroupID != nil && *in.GroupID != "" {
		g := *in.GroupID
		u.GroupID = &g
	}
	u.Bedrooms, u.NightlyRate, u.Status = int(in.Bedrooms), int64(in.NightlyRate), in.Status
	u.Amenities = list(in.Amenities)
}

// UnitID is the id the mock gives a unit: unit- and the lowercased code.
func UnitID(code string) string { return "unit-" + strings.ToLower(code) }

// Refusals that need stays from the booking context.

// ErrUnitInUse refuses deactivating a unit with confirmed stays ahead.
func ErrUnitInUse(code string) error {
	return errs.Newf("UNIT_IN_USE", "%s still has confirmed stays. Move or cancel them first.", code)
}

// ErrRoomsToAssign refuses turning off room type selling while stays still wait for a room.
func ErrRoomsToAssign(codes []string) error {
	return errs.Newf("ROOMS_TO_ASSIGN", "%s still wait for a room. Assign them first.", strings.Join(codes, ", "))
}

// CheckDeactivate is the UNIT_IN_USE rule of updateUnit.
func (u Unit) CheckDeactivate(next string, hasUpcomingStays bool) error {
	if next == UnitInactive && u.Status != UnitInactive && hasUpcomingStays {
		return ErrUnitInUse(u.Code)
	}
	return nil
}

// CheckRoomTypeSelling is the ROOMS_TO_ASSIGN rule of updateGroup.
func (g UnitGroup) CheckRoomTypeSelling(in GroupInput, waiting []string) error {
	if g.OperatorAssigns && !in.OperatorAssigns && len(waiting) > 0 {
		return ErrRoomsToAssign(waiting)
	}
	return nil
}
