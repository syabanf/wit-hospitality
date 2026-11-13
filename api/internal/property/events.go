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
}

// Group is a room type's state.
type Group struct {
	ID              string `json:"id"`
	VillaID         string `json:"villaId"`
	Name            string `json:"name"`
	Interchangeable bool   `json:"interchangeable"`
	OperatorAssigns bool   `json:"operatorAssigns"`
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
}

// Season is one yearly season of a rate plan.
type Season struct {
	Name  string `json:"name"`
	From  string `json:"from"`
	To    string `json:"to"`
	Kind  string `json:"kind"`
	Value int64  `json:"value"`
}

// RatePlan is a room type's price list.
type RatePlan struct {
	GroupID     string   `json:"groupId"`
	WeekdayRate int64    `json:"weekdayRate"`
	WeekendRate int64    `json:"weekendRate"`
	Seasons     []Season `json:"seasons"`
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
}
