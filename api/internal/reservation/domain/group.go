package domain

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// GroupDiscount is percent off every stay of the group without a discount of its own.
type GroupDiscount struct {
	Pct    float64 `json:"pct"`
	Reason string  `json:"reason"`
}

// BookingGroup is a group reservation; each stay is a booking that points at it.
type BookingGroup struct {
	ID          string          `json:"id"`
	Code        string          `json:"code"`
	Name        string          `json:"name"`
	LeadGuestID string          `json:"leadGuestId"`
	VillaIDs    []string        `json:"villaIds"`
	Source      string          `json:"source"`
	Billing     string          `json:"billing"`
	Discount    *GroupDiscount  `json:"discount"`
	Note        string          `json:"note"`
	CreatedBy   string          `json:"createdBy"`
	CreatedAt   string          `json:"createdAt"`
	CityLedger  json.RawMessage `json:"cityLedger,omitempty"`
	// WholeVilla marks a group that rents every villa unit of one villa together.
	WholeVilla bool  `json:"wholeVilla"`
	Version    int64 `json:"-"`
}

// GroupStayInput is one stay asked for in a group: a unit, or a room type assigned later.
type GroupStayInput struct {
	UnitID     *string      `json:"unitId"`
	RoomTypeID *string      `json:"roomTypeId"`
	CheckIn    string       `json:"checkIn"`
	CheckOut   string       `json:"checkOut"`
	Adults     float64      `json:"adults"`
	Children   float64      `json:"children"`
	Price      *PriceChange `json:"price"`
}

// Unit returns the stay's unit id, or "".
func (s GroupStayInput) Unit() string {
	if s.UnitID == nil {
		return ""
	}
	return *s.UnitID
}

// RoomType returns the stay's room type id, or "".
func (s GroupStayInput) RoomType() string {
	if s.RoomTypeID == nil {
		return ""
	}
	return *s.RoomTypeID
}

// MaxGroupStays is MAX_GROUP_STAYS.
const MaxGroupStays = 30

func groupStayFields(s GroupStayInput, prefix string, f *errs.Fields) {
	if s.Unit() == "" && s.RoomType() == "" {
		f.Add(prefix+"unitId", "Pick a unit or a room type.")
	}
	if msg := ValidateStay(s.CheckIn, s.CheckOut); msg != "" {
		f.Add(prefix+"checkOut", msg)
	}
	if !whole(s.Adults) || s.Adults < 1 {
		f.Add(prefix+"adults", "At least one adult.")
	}
	if !whole(s.Children) || s.Children < 0 {
		f.Add(prefix+"children", "Children cannot be negative.")
	}
}

// ValidateGroupStay is validateGroupStay.
func ValidateGroupStay(s GroupStayInput) error {
	var f errs.Fields
	groupStayFields(s, "", &f)
	return f.Err()
}

// GroupFields is validateGroup, keyed the way the form names them: stays.2.checkOut, discount.pct.
func GroupFields(name string, hasGuest bool, stays []GroupStayInput, discount *GroupDiscount) errs.Fields {
	var f errs.Fields
	if len([]rune(strings.TrimSpace(name))) < 3 {
		f.Add("name", "Name the group, for example the couple or the company.")
	}
	if !hasGuest {
		f.Add("guestId", "Pick the lead guest or add a new one.")
	}
	if len(stays) < 2 {
		f.Add("stays", "A group books at least two stays.")
	}
	if len(stays) > MaxGroupStays {
		f.Add("stays", fmt.Sprintf("A group books at most %d stays.", MaxGroupStays))
	}
	for i, s := range stays {
		groupStayFields(s, fmt.Sprintf("stays.%d.", i), &f)
	}
	if discount != nil {
		if !(discount.Pct > 0 && discount.Pct <= 100) {
			f.Add("discount.pct", "A percentage above 0, up to 100.")
		}
		if len([]rune(strings.TrimSpace(discount.Reason))) < 3 {
			f.Add("discount.reason", "Say why the group gets the discount.")
		}
	}
	return f
}

// StayPriceChange is stayPriceChange: the stay's own price, or the group discount when the stay
// has no discount of its own.
func StayPriceChange(own *PriceChange, discount *GroupDiscount) *PriceChange {
	if discount == nil || (own != nil && own.Discount != nil) {
		return own
	}
	out := PriceChange{Discount: &Discount{Kind: "percent", Value: discount.Pct, Per: "stay", Reason: "Group discount: " + strings.TrimSpace(discount.Reason)}}
	if own != nil {
		out.RateOverride, out.Reason = own.RateOverride, own.Reason
	}
	return &out
}

// GroupClash is a stay of a group that cannot be booked.
type GroupClash struct {
	Index  int
	Label  string
	Detail string
}

// GroupClashes is groupClashes: every stay tested against the stays held and the earlier stays
// of the same group, so two stays never claim one room.
func GroupClashes(c Catalog, stays []GroupStayInput, bookings []Holding, blocks []UnitBlock, overbookOf func(groupID string) int) []GroupClash {
	held := append([]Holding{}, bookings...)
	var clashes []GroupClash
	for i, s := range stays {
		if ValidateStay(s.CheckIn, s.CheckOut) != "" {
			continue
		}
		var unit Unit
		found := false
		if s.Unit() != "" {
			unit, found = c.Unit(s.Unit())
		} else {
			for _, u := range c.Units {
				if u.Group() == s.RoomType() && u.Status != "inactive" {
					unit, found = u, true
					break
				}
			}
		}
		if !found {
			clashes = append(clashes, GroupClash{Index: i, Label: "Room type", Detail: "has no open room."})
			continue
		}
		g, hasGroup := c.Group(unit.Group())
		label := unit.Code
		if s.Unit() == "" && hasGroup {
			label = g.Name
		}
		var first *Conflict
		if s.Unit() != "" {
			if cs := FindConflicts(unit.ID, s.CheckIn, s.CheckOut, held, blocks, ""); len(cs) > 0 {
				first = &cs[0]
			}
		}
		typeFull := SellsRoomType(g, hasGroup) && TypeAvailabilityOf(c, g.ID, s.CheckIn, s.CheckOut, held, blocks, "", overbookOf(g.ID)).Sellable < 1
		switch {
		case s.Unit() != "" && unit.Status == "inactive":
			clashes = append(clashes, GroupClash{Index: i, Label: label, Detail: "is inactive."})
		case first != nil:
			clashes = append(clashes, GroupClash{Index: i, Label: label, Detail: fmt.Sprintf("is held by %s from %s to %s.", first.Label, first.From, first.To)})
		case typeFull:
			clashes = append(clashes, GroupClash{Index: i, Label: label, Detail: "has every room taken on at least one of those nights."})
		default:
			held = append(held, Holding{ID: fmt.Sprintf("group-stay-%d", i), Code: fmt.Sprintf("stay %d of this group", i+1), UnitID: unit.ID, UnitAssigned: s.Unit() != "", Status: Confirmed, CheckIn: s.CheckIn, CheckOut: s.CheckOut})
		}
	}
	return clashes
}

// ErrGroupUnavailable is GROUP_UNAVAILABLE with clashMessage.
func ErrGroupUnavailable(clashes []GroupClash) error {
	parts := make([]string, len(clashes))
	for i, c := range clashes {
		parts[i] = c.Label + " " + strings.TrimSuffix(c.Detail, ".")
	}
	return errs.Newf("GROUP_UNAVAILABLE", "The group cannot be booked: %s.", strings.Join(parts, "; "))
}

// LiveStay is liveStay: still to arrive, in house, or waiting to be confirmed.
func LiveStay(status string) bool {
	return status == Draft || status == Confirmed || status == CheckedIn
}

// GroupStatus is groupStatus: in house while anyone is, out once every stay that came has left.
func GroupStatus(statuses []string) string {
	var came []string
	for _, s := range statuses {
		if s != Cancelled && s != NoShow {
			came = append(came, s)
		}
	}
	if len(came) == 0 {
		return "cancelled"
	}
	out, confirmed := true, false
	for _, s := range came {
		if s == CheckedIn {
			return "in_house"
		}
		out = out && s == CheckedOut
		confirmed = confirmed || s == Confirmed
	}
	switch {
	case out:
		return "checked_out"
	case confirmed:
		return "confirmed"
	}
	return "draft"
}

// Share is one part of a group payment.
type Share struct {
	BookingID string `json:"bookingId"`
	Amount    int64  `json:"amount"`
}

// Allocate is allocate: one payment split over the stays in order, each up to what it owes.
func Allocate(amount int64, dues []Share) []Share {
	left := amount
	var out []Share
	for _, d := range dues {
		share := min(left, max(0, d.Amount))
		if share > 0 {
			out = append(out, Share{BookingID: d.BookingID, Amount: share})
		}
		left -= share
	}
	return out
}

// StayOrder is stayOrder: by arrival, then by code.
func StayOrder(stays []Booking) []Booking {
	out := append([]Booking{}, stays...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].CheckIn != out[j].CheckIn {
			return out[i].CheckIn < out[j].CheckIn
		}
		return out[i].Code < out[j].Code
	})
	return out
}
