package domain

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"sort"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Booking statuses.
const (
	Draft      = "draft"
	Confirmed  = "confirmed"
	CheckedIn  = "checked_in"
	CheckedOut = "checked_out"
	Cancelled  = "cancelled"
	NoShow     = "no_show"
)

// Booking sources.
const (
	Direct = "direct"
	Airbnb = "airbnb"
)

// PaymentStatuses is PAYMENT_STATUSES.
var PaymentStatuses = []string{"unpaid", "partial", "paid"}

// UnitMovement is one unit change; the requested unit stays on the booking.
type UnitMovement struct {
	FromUnitID string `json:"fromUnitId"`
	ToUnitID   string `json:"toUnitId"`
	On         string `json:"on"`
	Reason     string `json:"reason"`
	By         string `json:"by"`
}

// CheckInDetails is what the front desk records on arrival. Numbers arrive as JSON numbers and
// are checked for whole values.
type CheckInDetails struct {
	IDVerified     bool    `json:"idVerified"`
	Deposit        float64 `json:"deposit"`
	KeysHanded     bool    `json:"keysHanded"`
	RulesExplained bool    `json:"rulesExplained"`
	ArrivalTime    string  `json:"arrivalTime"`
	Adults         float64 `json:"adults"`
	Children       float64 `json:"children"`
	Notes          string  `json:"notes"`
	// DepositAsked records whether the property asked a security deposit for the unit (see
	// Catalog.DepositAsked); the server sets it at check-in.
	DepositAsked bool `json:"depositAsked"`
}

// CheckOutDetails is what the front desk records on departure.
type CheckOutDetails struct {
	DepositReturned float64 `json:"depositReturned"`
	ExtraCharges    float64 `json:"extraCharges"`
	RoomInspected   bool    `json:"roomInspected"`
	KeysReturned    bool    `json:"keysReturned"`
	Notes           string  `json:"notes"`
}

// PartySize is the guests booked into the unit.
type PartySize struct {
	Adults   int `json:"adults"`
	Children int `json:"children"`
}

// Booking is the console's Booking. Optional fields the TypeScript type marks with `?` are
// omitted when absent, so a stored seed booking reads back exactly as the mock serves it.
// CityLedger belongs to billing and passes through untouched.
type Booking struct {
	ID              string           `json:"id"`
	Code            string           `json:"code"`
	GuestID         string           `json:"guestId"`
	UnitID          string           `json:"unitId"`
	UnitAssigned    bool             `json:"unitAssigned"`
	RequestedUnitID string           `json:"requestedUnitId"`
	Source          string           `json:"source"`
	AirbnbAccountID *string          `json:"airbnbAccountId"`
	AirbnbCode      *string          `json:"airbnbCode"`
	CheckIn         string           `json:"checkIn"`
	CheckOut        string           `json:"checkOut"`
	ListRates       []int64          `json:"listRates"`
	ListSources     *[]PriceSource   `json:"listSources,omitempty"`
	PriceMode       string           `json:"priceMode,omitempty"`
	RateOverride    *int64           `json:"rateOverride"`
	Discount        *Discount        `json:"discount"`
	PriceSetBy      *PriceStamp      `json:"priceSetBy"`
	Status          string           `json:"status"`
	Notes           string           `json:"notes"`
	PaymentStatus   string           `json:"paymentStatus"`
	PaidAmount      float64          `json:"paidAmount"`
	AirbnbFee       float64          `json:"airbnbFee"`
	Movements       []UnitMovement   `json:"movements"`
	CreatedOn       string           `json:"createdOn"`
	CheckedInOn     *string          `json:"checkedInOn"`
	CheckedOutOn    *string          `json:"checkedOutOn"`
	Arrival         *CheckInDetails  `json:"arrival"`
	Departure       *CheckOutDetails `json:"departure"`
	BookingGroupID  string           `json:"bookingGroupId,omitempty"`
	PartySize       *PartySize       `json:"partySize,omitempty"`
	RestrictionNote *RestrictionNote `json:"restrictionNote,omitempty"`
	NightsPosted    *[]string        `json:"nightsPosted,omitempty"`
	CityLedger      json.RawMessage  `json:"cityLedger,omitempty"`
	Version         int64            `json:"-"`
}

// IsChannel is isChannel: channel bookings keep the price the channel sold.
func (b Booking) IsChannel() bool { return b.Source != Direct }

// Over reports a stay that ended: checked out, cancelled or a no-show.
func (b Booking) Over() bool {
	return b.Status == CheckedOut || b.Status == Cancelled || b.Status == NoShow
}

// Holding is what availability reads off a stay, so a group can test stays it has not saved.
type Holding struct {
	ID           string
	Code         string
	UnitID       string
	UnitAssigned bool
	Status       string
	CheckIn      string
	CheckOut     string
}

// Hold returns the booking's holding.
func (b Booking) Hold() Holding {
	return Holding{ID: b.ID, Code: b.Code, UnitID: b.UnitID, UnitAssigned: b.UnitAssigned, Status: b.Status, CheckIn: b.CheckIn, CheckOut: b.CheckOut}
}

// Occupies is occupies: confirmed and checked-in stays hold the unit.
func Occupies(status string) bool { return status == Confirmed || status == CheckedIn }

// Overlaps compares half-open ranges: a check-out and a check-in on one day do not clash.
func Overlaps(aFrom, aTo, bFrom, bTo string) bool { return aFrom < bTo && bFrom < aTo }

// Conflict is something that already holds a unit.
type Conflict struct {
	Kind  string
	ID    string
	From  string
	To    string
	Label string
}

// BlockReasonLabel is BLOCK_REASON_LABEL.
var BlockReasonLabel = map[string]string{"maintenance": "Maintenance", "owner": "Owner stay", "cleaning": "Deep clean", "other": "Other"}

// FindConflicts is findConflicts: what holds unitID during the stay, sorted by start.
func FindConflicts(unitID, checkIn, checkOut string, bookings []Holding, blocks []UnitBlock, excludeID string) []Conflict {
	var out []Conflict
	for _, b := range bookings {
		if b.UnitID == unitID && b.UnitAssigned && b.ID != excludeID && Occupies(b.Status) && Overlaps(b.CheckIn, b.CheckOut, checkIn, checkOut) {
			out = append(out, Conflict{Kind: "booking", ID: b.ID, From: b.CheckIn, To: b.CheckOut, Label: b.Code})
		}
	}
	for _, k := range blocks {
		if k.UnitID == unitID && Overlaps(k.From, k.To, checkIn, checkOut) {
			out = append(out, Conflict{Kind: "block", ID: k.ID, From: k.From, To: k.To, Label: BlockReasonLabel[k.Reason]})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].From < out[j].From })
	return out
}

// MaxNights is MAX_NIGHTS.
const MaxNights = 90

var isoDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// ValidateStay is validateStay: why a stay is impossible, or "".
func ValidateStay(checkIn, checkOut string) string {
	if !isoDate.MatchString(checkIn) || !isoDate.MatchString(checkOut) {
		return "Pick both dates."
	}
	n := DaysBetween(checkIn, checkOut)
	if n < 1 {
		return "Check-out must be after check-in."
	}
	if n > MaxNights {
		return fmt.Sprintf("A stay is at most %d nights.", MaxNights)
	}
	return ""
}

// Transitions is TRANSITIONS.
var Transitions = map[string][]string{
	Draft:      {Confirmed, Cancelled},
	Confirmed:  {CheckedIn, Cancelled, NoShow},
	CheckedIn:  {CheckedOut},
	CheckedOut: {},
	Cancelled:  {},
	NoShow:     {},
}

// CanTransition is canTransition.
func CanTransition(from, to string) bool { return slices.Contains(Transitions[from], to) }

// NextStep is nextStep: the forward step, or "".
func NextStep(status string) string {
	for _, s := range Transitions[status] {
		if s != Cancelled && s != NoShow {
			return s
		}
	}
	return ""
}

// ErrInvalidState is BOOKING_INVALID_STATE.
func ErrInvalidState(message string) error { return errs.New("BOOKING_INVALID_STATE", message) }

// CheckTransition refuses a step the lifecycle does not allow.
func (b Booking) CheckTransition(to string) error {
	if CanTransition(b.Status, to) {
		return nil
	}
	return ErrInvalidState(fmt.Sprintf("A %s booking cannot become %s.", spaced(b.Status), spaced(to)))
}

// CheckCan refuses a step worded for the desk: "A confirmed booking cannot be checked out."
func (b Booking) CheckCan(to, verb string) error {
	if CanTransition(b.Status, to) {
		return nil
	}
	return ErrInvalidState(fmt.Sprintf("A %s booking cannot be %s.", spaced(b.Status), verb))
}

// ErrUnitUnassigned is UNIT_UNASSIGNED before check-in.
func ErrUnitUnassigned(code string) error {
	return errs.Newf("UNIT_UNASSIGNED", "Assign a room to %s before checking in.", code)
}

func whole(f float64) bool { return !math.IsInf(f, 0) && !math.IsNaN(f) && f == math.Trunc(f) }

// ValidateCheckIn is validateCheckIn; a room hands over a key card, a villa its keys or access code.
func ValidateCheckIn(d CheckInDetails, unitKind string) error {
	var f errs.Fields
	if !d.IDVerified {
		f.Add("idVerified", "Match the ID against the booking before checking in.")
	}
	if !whole(d.Deposit) || d.Deposit < 0 {
		f.Add("deposit", "Enter the deposit in whole rupiah, or zero.")
	}
	if !d.KeysHanded {
		keys := "Hand over the keys or access code."
		if unitKind == KindRoom {
			keys = "Hand over the room key card."
		}
		f.Add("keysHanded", keys)
	}
	if !whole(d.Adults) || d.Adults < 1 {
		f.Add("adults", "At least one adult.")
	}
	if !whole(d.Children) || d.Children < 0 {
		f.Add("children", "Children cannot be negative.")
	}
	return f.Err()
}

// ValidateCheckOut is validateCheckOut; held is the deposit taken at check-in.
func ValidateCheckOut(d CheckOutDetails, held float64) error {
	var f errs.Fields
	if !whole(d.DepositReturned) || d.DepositReturned < 0 {
		f.Add("depositReturned", "Enter the amount returned, or zero.")
	} else if d.DepositReturned > held {
		f.Add("depositReturned", fmt.Sprintf("Only %s is held as deposit.", number(held)))
	}
	if !whole(d.ExtraCharges) || d.ExtraCharges < 0 {
		f.Add("extraCharges", "Enter the charges in whole rupiah, or zero.")
	}
	if !d.RoomInspected {
		f.Add("roomInspected", "Inspect the room before closing the stay.")
	}
	return f.Err()
}

// number prints a JSON number the way JavaScript's template literal does.
func number(f float64) string {
	if whole(f) {
		return fmt.Sprintf("%d", int64(f))
	}
	return fmt.Sprintf("%g", f)
}

// PaymentInput is the booking's own payment summary.
type PaymentInput struct {
	PaymentStatus string  `json:"paymentStatus"`
	PaidAmount    float64 `json:"paidAmount"`
	AirbnbFee     float64 `json:"airbnbFee"`
}

// ValidatePayment is validatePayment against the stay total with tax.
func ValidatePayment(p PaymentInput, total int64, source string) error {
	var f errs.Fields
	if !slices.Contains(PaymentStatuses, p.PaymentStatus) {
		f.Add("paymentStatus", "Pick the payment status.")
	}
	if !whole(p.PaidAmount) || p.PaidAmount < 0 {
		f.Add("paidAmount", "Enter the amount paid in whole rupiah, or zero.")
	} else if p.PaidAmount > float64(total) {
		f.Add("paidAmount", "More than the booking total.")
	}
	switch {
	case !whole(p.AirbnbFee) || p.AirbnbFee < 0:
		f.Add("airbnbFee", "Enter the Airbnb fee in whole rupiah, or zero.")
	case p.AirbnbFee > float64(total):
		f.Add("airbnbFee", "The fee cannot exceed the booking total.")
	case source == Direct && p.AirbnbFee > 0:
		f.Add("airbnbFee", "A direct booking has no Airbnb fee.")
	}
	return f.Err()
}

// SellsRoomType is sellsRoomType: guests book the type and the operator picks the room.
func SellsRoomType(g UnitGroup, ok bool) bool { return ok && g.OperatorAssigns }

// TypeAvailability is TypeAvailability's result.
type TypeAvailability struct {
	Free     int
	Sellable int
	Units    []Unit
}

// TypeAvailabilityOf is typeAvailability: per night, the type's open rooms less blocks, assigned
// stays and stays waiting for a room; overbook lets it sell past the rooms by that many a night.
func TypeAvailabilityOf(c Catalog, groupID, checkIn, checkOut string, bookings []Holding, blocks []UnitBlock, excludeID string, overbook int) TypeAvailability {
	var rooms []Unit
	ids := map[string]bool{}
	for _, u := range c.Units {
		if u.Group() == groupID && u.Status != "inactive" {
			rooms = append(rooms, u)
			ids[u.ID] = true
		}
	}
	var live []Holding
	for _, b := range bookings {
		if b.ID != excludeID && Occupies(b.Status) && ids[b.UnitID] && Overlaps(b.CheckIn, b.CheckOut, checkIn, checkOut) {
			live = append(live, b)
		}
	}
	free := len(rooms)
	for _, date := range EachDay(checkIn, checkOut) {
		taken := map[string]bool{}
		for _, k := range blocks {
			if ids[k.UnitID] && k.From <= date && date < k.To {
				taken[k.UnitID] = true
			}
		}
		waiting := 0
		for _, b := range live {
			if b.CheckIn <= date && date < b.CheckOut {
				if b.UnitAssigned {
					taken[b.UnitID] = true
				} else {
					waiting++
				}
			}
		}
		free = min(free, len(rooms)-len(taken)-waiting)
	}
	out := TypeAvailability{Free: max(0, free), Sellable: max(0, free+overbook)}
	for _, u := range rooms {
		if len(FindConflicts(u.ID, checkIn, checkOut, bookings, blocks, excludeID)) == 0 {
			out.Units = append(out.Units, u)
		}
	}
	return out
}

// InterchangeableWith lists the active units of the same interchangeable room type.
func InterchangeableWith(c Catalog, unitID string) []Unit {
	g, ok := c.GroupOf(unitID)
	if !ok || !g.Interchangeable {
		return nil
	}
	var out []Unit
	for _, u := range c.Units {
		if u.Group() == g.ID && u.ID != unitID && u.Status == "active" {
			out = append(out, u)
		}
	}
	return out
}

// Availability answers the booking rules that read the catalog and what already holds it.
type Availability struct {
	Catalog  Catalog
	Bookings []Holding
	Policies []OverbookPolicy
}

// AssertFree is the mock's assertFree: the unit is active, nothing holds it, and in a villa that
// sells the room type the type still has a sellable room.
func (a Availability) AssertFree(unitID, checkIn, checkOut, excludeID string) error {
	unit, ok := a.Catalog.Unit(unitID)
	if !ok {
		return errs.NotFound("unit", unitID)
	}
	if unit.Status == "inactive" {
		return errs.Newf("UNIT_UNAVAILABLE", "%s is inactive.", unit.Code)
	}
	if c := FindConflicts(unitID, checkIn, checkOut, a.Bookings, a.Catalog.Blocks, excludeID); len(c) > 0 {
		return errs.Newf("BOOKING_OVERLAP", "%s is held by %s from %s to %s.", unit.Code, c[0].Label, c[0].From, c[0].To)
	}
	if unit.GroupID != nil {
		return a.AssertTypeRoom(*unit.GroupID, checkIn, checkOut, excludeID)
	}
	return nil
}

// AssertTypeRoom is assertTypeRoom: stays waiting for a room count against every night too.
func (a Availability) AssertTypeRoom(groupID, checkIn, checkOut, excludeID string) error {
	g, ok := a.Catalog.Group(groupID)
	if !SellsRoomType(g, ok) {
		return nil
	}
	if TypeAvailabilityOf(a.Catalog, groupID, checkIn, checkOut, a.Bookings, a.Catalog.Blocks, excludeID, OverbookLimit(a.Policies, groupID)).Sellable < 1 {
		return errs.Newf("ROOM_TYPE_FULL", "Every %s room is taken on at least one of those nights.", g.Name)
	}
	return nil
}

// AssertStayFree is assertStayFree: the room when the stay has one, the room type while it waits.
func (a Availability) AssertStayFree(b Holding, checkIn, checkOut, excludeID string) error {
	if b.UnitAssigned {
		return a.AssertFree(b.UnitID, checkIn, checkOut, excludeID)
	}
	u, _ := a.Catalog.Unit(b.UnitID)
	return a.AssertTypeRoom(u.Group(), checkIn, checkOut, excludeID)
}

// ErrNotInterchangeable is UNIT_NOT_INTERCHANGEABLE.
func ErrNotInterchangeable(message string) error {
	return errs.New("UNIT_NOT_INTERCHANGEABLE", message)
}

// ErrChannelPriceLocked is CHANNEL_PRICE_LOCKED for an existing stay.
func ErrChannelPriceLocked(b Booking) error {
	who := "the channel"
	if b.Source == Airbnb {
		who = "Airbnb"
	}
	return errs.Newf("CHANNEL_PRICE_LOCKED", "%s keeps the price %s sold it for.", b.Code, who)
}
