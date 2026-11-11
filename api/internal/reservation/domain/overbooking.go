package domain

import (
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// OverbookPolicy is how many stays a night a room type may sell past its rooms.
type OverbookPolicy struct {
	GroupID string `json:"groupId"`
	Limit   int    `json:"limit"`
}

// MaxOverbook is MAX_OVERBOOK.
const MaxOverbook = 5

// OverbookLimit is overbookLimit.
func OverbookLimit(policies []OverbookPolicy, groupID string) int {
	for _, p := range policies {
		if p.GroupID == groupID {
			return p.Limit
		}
	}
	return 0
}

// ValidateOverbook is validateOverbook.
func ValidateOverbook(limit float64) error {
	if whole(limit) && limit >= 0 && limit <= MaxOverbook {
		return nil
	}
	return errs.Invalid("limit", fmt.Sprintf("Enter whole stays from 0 to %d.", MaxOverbook))
}

// OverbookedNight is a night a room type holds more stays than open rooms.
type OverbookedNight struct {
	GroupID string `json:"groupId"`
	Date    string `json:"date"`
	Rooms   int    `json:"rooms"`
	Held    int    `json:"held"`
	Over    int    `json:"over"`
}

// OverbookedNights is overbookedNights: only room types that sell by type can get there.
func OverbookedNights(c Catalog, groupID, from, to string, bookings []Holding, blocks []UnitBlock) []OverbookedNight {
	g, ok := c.Group(groupID)
	if !SellsRoomType(g, ok) {
		return nil
	}
	ids := map[string]bool{}
	rooms := 0
	for _, u := range c.Units {
		if u.Group() == groupID && u.Status != "inactive" {
			ids[u.ID] = true
			rooms++
		}
	}
	var out []OverbookedNight
	for _, date := range EachDay(from, to) {
		blocked := map[string]bool{}
		for _, k := range blocks {
			if ids[k.UnitID] && k.From <= date && date < k.To {
				blocked[k.UnitID] = true
			}
		}
		held := 0
		for _, b := range bookings {
			if Occupies(b.Status) && ids[b.UnitID] && b.CheckIn <= date && date < b.CheckOut {
				held++
			}
		}
		open := rooms - len(blocked)
		if held > open {
			out = append(out, OverbookedNight{GroupID: groupID, Date: date, Rooms: open, Held: held, Over: held - open})
		}
	}
	return out
}

// WalkDestinationLabel is WALK_DESTINATION_LABEL.
var WalkDestinationLabel = map[string]string{"group_villa": "Another villa of ours", "outside": "Outside property"}

// WalkInput is the walk form; Receipts belong to finance and are not kept here.
type WalkInput struct {
	Destination  string  `json:"destination"`
	UnitID       *string `json:"unitId"`
	Property     string  `json:"property"`
	Cost         float64 `json:"cost"`
	Method       string  `json:"method"`
	Compensation string  `json:"compensation"`
	Reason       string  `json:"reason"`
}

// Walk is a guest the front desk walked, with what it cost.
type Walk struct {
	ID            string  `json:"id"`
	Number        string  `json:"number"`
	Cost          int64   `json:"cost"`
	Method        string  `json:"method"`
	Destination   string  `json:"destination"`
	Property      string  `json:"property"`
	BookingID     string  `json:"bookingId"`
	BookingCode   string  `json:"bookingCode"`
	GroupID       string  `json:"groupId"`
	Date          string  `json:"date"`
	FromUnitID    string  `json:"fromUnitId"`
	ToUnitID      *string `json:"toUnitId"`
	Compensation  string  `json:"compensation"`
	Reason        string  `json:"reason"`
	TransactionID *string `json:"transactionId"`
	By            string  `json:"by"`
	ByID          string  `json:"byId"`
}

// ValidateWalk is validateWalk.
func ValidateWalk(in WalkInput) error {
	var f errs.Fields
	if in.Destination == "group_villa" && (in.UnitID == nil || *in.UnitID == "") {
		f.Add("unitId", "Pick the unit the guest moves to.")
	}
	if in.Destination == "outside" && len([]rune(Trim(in.Property))) < 3 {
		f.Add("property", "Name the property the guest goes to.")
	}
	if !whole(in.Cost) || in.Cost < 0 {
		f.Add("cost", "Enter the cost in whole rupiah, or zero.")
	}
	if len([]rune(Trim(in.Reason))) < 3 {
		f.Add("reason", "Say why the guest is walked.")
	}
	return f.Err()
}
