// Package property is the published language of the property context: the events it publishes.
// Payloads carry the full state of the record plus the villa and location it sits in, so a
// consumer builds its read model from one event without calling back. Other contexts may import
// this package and nothing below it.
package property

// Event types; the suffix is the payload version.
const (
	EventLocationCreated = "property.location.created.v1"
	EventLocationUpdated = "property.location.updated.v1"
	EventVillaCreated    = "property.villa.created.v1"
	EventVillaUpdated    = "property.villa.updated.v1"
	EventGroupCreated    = "property.unit_group.created.v1"
	EventGroupUpdated    = "property.unit_group.updated.v1"
	EventUnitCreated     = "property.unit.created.v1"
	EventUnitUpdated     = "property.unit.updated.v1"
	EventRatePlanSaved   = "property.rate_plan.saved.v1"
	EventBlockAdded      = "property.unit_block.added.v1"
	EventBlockRemoved    = "property.unit_block.removed.v1"
	EventBlockTrimmed    = "property.unit_block.trimmed.v1"
	EventPropertyCreated = "property.property.created.v1"
	EventSectionSaved    = "property.section.saved.v1"
	EventSectionRemoved  = "property.section.removed.v1"
)

// Location is a location's state.
type Location struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Area string `json:"area"`
}

// Photo is an uploaded image on a villa or unit; the first in a list is the cover.
type Photo struct {
	FileID  string `json:"fileId"`
	Caption string `json:"caption"`
}

// Villa is a villa's state. The contact, bank and licence fields are back office only and left out when
// empty, so a copy that serves the public site can drop them.
type Villa struct {
	ID                 string   `json:"id"`
	LocationID         string   `json:"locationId"`
	Code               string   `json:"code"`
	Name               string   `json:"name"`
	Description        string   `json:"description"`
	Facilities         []string `json:"facilities"`
	Address            string   `json:"address"`
	Lat                *float64 `json:"lat"`
	Lng                *float64 `json:"lng"`
	Phone              string   `json:"phone,omitempty"`
	Email              string   `json:"email,omitempty"`
	CheckInTime        string   `json:"checkInTime"`
	CheckOutTime       string   `json:"checkOutTime"`
	LicenseNo          string   `json:"licenseNo,omitempty"`
	BankName           string   `json:"bankName,omitempty"`
	BankAccountNo      string   `json:"bankAccountNo,omitempty"`
	BankAccountName    string   `json:"bankAccountName,omitempty"`
	HouseRules         string   `json:"houseRules"`
	CancellationPolicy string   `json:"cancellationPolicy"`
	DepositKind        string   `json:"depositKind"`
	DepositValue       int64    `json:"depositValue"`
	Photos             []Photo  `json:"photos"`
	// Operation is villa, hotel or mixed; StayoverEvery is the days between stayover cleans of a
	// guest in house (0 none); WholeRental lets the villa be booked whole, at WholeNightlyRate a
	// night (0 the sum of its villa units); DepositOnCheckIn asks a security deposit at check-in
	// (into villa units only in a mixed property). An event from before they existed carries an
	// empty operation, which reads as a villa without stayovers or whole rental that asks a deposit.
	Operation        string `json:"operation"`
	StayoverEvery    int    `json:"stayoverEvery"`
	WholeRental      bool   `json:"wholeRental"`
	WholeNightlyRate int64  `json:"wholeNightlyRate"`
	DepositOnCheckIn bool   `json:"depositOnCheckIn"`
	// LateCheckoutFee is what a room stay pays for a late check-out (rooms only in a mixed
	// property); nil on an event from before it existed, which reads as the operation's default.
	LateCheckoutFee *int64 `json:"lateCheckoutFee"`
	// EarlyCheckinFee is what a room stay pays to arrive before the house check-in time (rooms only
	// in a mixed property); RequireRegistrationCard holds check-in until the guest signed the
	// registration card. Nil on an event from before them, which reads as the operation's default.
	EarlyCheckinFee         *int64 `json:"earlyCheckinFee"`
	RequireRegistrationCard *bool  `json:"requireRegistrationCard"`
}

// DefaultEarlyCheckinFee is the early check-in fee a property of the operation starts with: none in
// a villa, 500000 where rooms are sold.
func DefaultEarlyCheckinFee(operation string) int64 { return DefaultLateCheckoutFee(operation) }

// DefaultRequireRegistrationCard is whether a property of the operation holds check-in for a signed
// registration card: wherever rooms are sold.
func DefaultRequireRegistrationCard(operation string) bool {
	return operation == "hotel" || operation == "mixed"
}

// DefaultLateCheckoutFee is the fee a property of the operation starts with: none in a villa,
// 500000 where rooms are sold.
func DefaultLateCheckoutFee(operation string) int64 {
	if operation == "hotel" || operation == "mixed" {
		return 500_000
	}
	return 0
}

// Group is a room type's state. Kind is room or villa; empty (an event from before kinds) reads
// as villa. A unit's kind is its room type's; a unit without one is a room in a hotel and a villa
// otherwise.
type Group struct {
	ID              string `json:"id"`
	VillaID         string `json:"villaId"`
	Name            string `json:"name"`
	Interchangeable bool   `json:"interchangeable"`
	OperatorAssigns bool   `json:"operatorAssigns"`
	Kind            string `json:"kind"`
}

// Bed is a bed type in a unit and how many of it.
type Bed struct {
	Type  string `json:"type"`
	Count int    `json:"count"`
}

// Unit is a unit's state. A party fits when adults <= MaxAdults + ExtraBeds and adults + children
// <= MaxAdults + MaxChildren + ExtraBeds. StatusReason and StatusUntil explain the current status.
type Unit struct {
	ID           string   `json:"id"`
	VillaID      string   `json:"villaId"`
	GroupID      *string  `json:"groupId"`
	Code         string   `json:"code"`
	Name         string   `json:"name"`
	Bedrooms     int      `json:"bedrooms"`
	NightlyRate  int64    `json:"nightlyRate"`
	Status       string   `json:"status"`
	Amenities    []string `json:"amenities"`
	MaxAdults    int      `json:"maxAdults"`
	MaxChildren  int      `json:"maxChildren"`
	Beds         []Bed    `json:"beds"`
	SizeSqm      *int     `json:"sizeSqm"`
	View         string   `json:"view"`
	ExtraBeds    int      `json:"extraBeds"`
	ExtraBedRate int64    `json:"extraBedRate"`
	Photos       []Photo  `json:"photos"`
	StatusReason string   `json:"statusReason"`
	StatusUntil  *string  `json:"statusUntil"`
	Floor        string   `json:"floor"`
	// HostID is the default host of a villa-kind unit, an employee id from people.
	HostID *string `json:"hostId"`
}

// Season is one yearly season of a rate plan.
type Season struct {
	Name  string `json:"name"`
	From  string `json:"from"`
	To    string `json:"to"`
	Kind  string `json:"kind"`
	Value int64  `json:"value"`
}

// RatePackage is one way a hotel room type sells beside Room only. Rate is plan (the plan's
// nightly rate), fixed (Value rupiah every night) or percent (the plan's rate less Value percent);
// Breakfast is rupiah per person per night; AccountID is the company's city ledger account on a
// corporate rate.
type RatePackage struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Rate      string  `json:"rate"`
	Value     int64   `json:"value"`
	Breakfast int64   `json:"breakfast"`
	AccountID *string `json:"accountId"`
}

// RatePlan is a room type's price list. Packages is nil on an event from before packages.
type RatePlan struct {
	GroupID     string        `json:"groupId"`
	WeekdayRate int64         `json:"weekdayRate"`
	WeekendRate int64         `json:"weekendRate"`
	Seasons     []Season      `json:"seasons"`
	Packages    []RatePackage `json:"packages,omitempty"`
}

// Section is a named set of rooms of one hotel or mixed property.
type Section struct {
	ID      string   `json:"id"`
	VillaID string   `json:"villaId"`
	Name    string   `json:"name"`
	UnitIDs []string `json:"unitIds"`
}

// SectionSaved is the payload of section.saved.
type SectionSaved struct {
	Section    Section `json:"section"`
	LocationID string  `json:"locationId"`
}

// SectionRemoved is the payload of section.removed.
type SectionRemoved struct {
	ID         string `json:"id"`
	VillaID    string `json:"villaId"`
	LocationID string `json:"locationId"`
}

// Block is a unit block's state.
type Block struct {
	ID     string `json:"id"`
	UnitID string `json:"unitId"`
	From   string `json:"from"`
	To     string `json:"to"`
	Reason string `json:"reason"`
	Note   string `json:"note"`
}

// LocationEvent is the payload of location.created and location.updated.
type LocationEvent struct {
	Location Location `json:"location"`
}

// VillaEvent is the payload of villa.created and villa.updated.
type VillaEvent struct {
	Villa Villa `json:"villa"`
}

// GroupEvent is the payload of unit_group.created and unit_group.updated.
type GroupEvent struct {
	Group      Group  `json:"group"`
	LocationID string `json:"locationId"`
}

// UnitEvent is the payload of unit.created and unit.updated.
type UnitEvent struct {
	Unit       Unit   `json:"unit"`
	LocationID string `json:"locationId"`
}

// RatePlanSaved is the payload of rate_plan.saved.
type RatePlanSaved struct {
	Plan       RatePlan `json:"plan"`
	VillaID    string   `json:"villaId"`
	LocationID string   `json:"locationId"`
}

// BlockAdded is the payload of unit_block.added.
type BlockAdded struct {
	Block      Block  `json:"block"`
	VillaID    string `json:"villaId"`
	LocationID string `json:"locationId"`
}

// BlockRemoved is the payload of unit_block.removed.
type BlockRemoved struct {
	ID     string `json:"id"`
	UnitID string `json:"unitId"`
}

// PropertyCreated follows the wizard's per-record events and names what it created together.
type PropertyCreated struct {
	VillaID  string   `json:"villaId"`
	GroupIDs []string `json:"groupIds"`
	UnitIDs  []string `json:"unitIds"`
	// LocationID is the villa's location; MinStays lists the minimum stay each room type created
	// here starts with (rooms 1 night, villas 2), for the context that keeps stay restrictions.
	LocationID string    `json:"locationId"`
	MinStays   []MinStay `json:"minStays"`
}

// MinStay is a room type's starting minimum stay in nights.
type MinStay struct {
	GroupID string `json:"groupId"`
	Kind    string `json:"kind"`
	Nights  int    `json:"nights"`
}
