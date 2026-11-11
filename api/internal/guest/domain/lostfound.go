package domain

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// LostStatusLabel names the lost item statuses.
var LostStatusLabel = map[string]string{"found": "Found", "stored": "Stored", "contacted": "Guest contacted", "returned": "Returned", "disposed": "Disposed", "donated": "Donated"}

// LostTransitions is LOST_TRANSITIONS: logged, put away, the owner told, then back to them;
// unclaimed items leave after the holding period.
var LostTransitions = map[string][]string{
	"found":     {"stored", "contacted", "returned"},
	"stored":    {"contacted", "returned", "disposed", "donated"},
	"contacted": {"returned", "stored", "disposed", "donated"},
	"returned":  {},
	"disposed":  {},
	"donated":   {},
}

// IsClosedLost reports a status with no way out.
func IsClosedLost(status string) bool { return len(LostTransitions[status]) == 0 }

// LostReturn is how the item went back to its owner.
type LostReturn struct {
	Method   string `json:"method"`
	To       string `json:"to"`
	Courier  string `json:"courier"`
	Tracking string `json:"tracking"`
}

// LostEvent is one line of an item's history.
type LostEvent struct {
	Status string `json:"status"`
	By     string `json:"by"`
	At     string `json:"at"`
	Note   string `json:"note"`
}

// LostItem is an item found in a villa.
type LostItem struct {
	ID          string            `json:"id"`
	Number      string            `json:"number"`
	FoundOn     string            `json:"foundOn"`
	VillaID     string            `json:"villaId"`
	UnitID      *string           `json:"unitId"`
	Where       string            `json:"where"`
	Description string            `json:"description"`
	Photos      []json.RawMessage `json:"photos"`
	FoundBy     string            `json:"foundBy"`
	GuestID     *string           `json:"guestId"`
	BookingID   *string           `json:"bookingId"`
	Storage     string            `json:"storage"`
	Status      string            `json:"status"`
	Returned    *LostReturn       `json:"returned"`
	History     []LostEvent       `json:"history"`
	Version     int64             `json:"-"`
}

// LostItemInput is LostItemInput. Photos are attachments the files context stored; the guest
// context keeps them as given.
type LostItemInput struct {
	FoundOn     string            `json:"foundOn"`
	VillaID     string            `json:"villaId"`
	UnitID      *string           `json:"unitId"`
	Where       string            `json:"where"`
	Description string            `json:"description"`
	Photos      []json.RawMessage `json:"photos"`
	GuestID     *string           `json:"guestId"`
	BookingID   *string           `json:"bookingId"`
	Storage     string            `json:"storage"`
}

// LostMove is a status change.
type LostMove struct {
	To       string      `json:"to"`
	Note     string      `json:"note"`
	Returned *LostReturn `json:"returned"`
}

// LostFoundSettings is the holding period.
type LostFoundSettings struct {
	HoldDays int `json:"holdDays"`
}

// DefaultLostFound is DEFAULT_LOST_FOUND.
var DefaultLostFound = LostFoundSettings{HoldDays: 90}

// ValidateLostFoundSettings holds items between 7 and 365 days.
func ValidateLostFoundSettings(s LostFoundSettings) error {
	if s.HoldDays < 7 || s.HoldDays > 365 {
		return errs.New(errs.CodeValidation, "Hold items between 7 and 365 days.")
	}
	return nil
}

// ValidateLostItem is validateLostItem, in its field order.
func ValidateLostItem(in LostItemInput, today string) error {
	var f errs.Fields
	if in.VillaID == "" {
		f.Add("villaId", "Pick the villa.")
	}
	switch {
	case in.FoundOn == "":
		f.Add("foundOn", "Enter the day it was found.")
	case !isoDay.MatchString(in.FoundOn):
		f.Add("foundOn", "Enter a date.")
	case in.FoundOn > today:
		f.Add("foundOn", "The day cannot be in the future.")
	}
	if len([]rune(strings.TrimSpace(in.Description))) < 3 {
		f.Add("description", "Describe the item.")
	}
	if len([]rune(strings.TrimSpace(in.Where))) < 2 {
		f.Add("where", "Say where it was found.")
	}
	return f.Err()
}

// HoldUntil is holdUntil: the first day an unclaimed item may leave.
func HoldUntil(foundOn string, s LostFoundSettings) string { return clock.AddDays(foundOn, s.HoldDays) }

// ValidateLostMove is validateLostMove; a refusal is LOST_ITEM_INVALID_STATE.
func ValidateLostMove(item LostItem, move LostMove, today string, s LostFoundSettings) error {
	refuse := func(msg string) error { return errs.New("LOST_ITEM_INVALID_STATE", msg) }
	if !slices.Contains(LostTransitions[item.Status], move.To) {
		to := LostStatusLabel[move.To]
		if to == "" {
			to = move.To
		}
		return refuse(fmt.Sprintf("A %s item cannot become %s.", strings.ToLower(LostStatusLabel[item.Status]), strings.ToLower(to)))
	}
	if move.To == "returned" {
		r := move.Returned
		if r == nil || len([]rune(strings.TrimSpace(r.To))) < 2 {
			return refuse("Say who received the item.")
		}
		if r.Method != "pickup" && r.Method != "courier" {
			return refuse("Say how the item went back: picked up or by courier.")
		}
		if r.Method == "courier" && (strings.TrimSpace(r.Courier) == "" || strings.TrimSpace(r.Tracking) == "") {
			return refuse("Enter the courier and the tracking number.")
		}
	}
	if (move.To == "disposed" || move.To == "donated") && today < HoldUntil(item.FoundOn, s) {
		return refuse(fmt.Sprintf("Hold the item until %s; the holding period is %d days.", HoldUntil(item.FoundOn, s), s.HoldDays))
	}
	return nil
}

// Move applies an accepted move.
func (i *LostItem) Move(move LostMove, by, at string) {
	i.Status = move.To
	if move.To == "returned" && move.Returned != nil {
		r := *move.Returned
		i.Returned = &LostReturn{Method: r.Method, To: strings.TrimSpace(r.To), Courier: strings.TrimSpace(r.Courier), Tracking: strings.TrimSpace(r.Tracking)}
	}
	i.History = append(i.History, LostEvent{Status: move.To, By: by, At: at, Note: strings.TrimSpace(move.Note)})
}

// Apply sets the cleaned input fields; id, number, finder, status and history stay.
func (i *LostItem) Apply(in LostItemInput) {
	i.FoundOn, i.VillaID, i.UnitID = in.FoundOn, in.VillaID, emptyToNil(in.UnitID)
	i.Where, i.Description, i.Storage = strings.TrimSpace(in.Where), strings.TrimSpace(in.Description), strings.TrimSpace(in.Storage)
	i.GuestID, i.BookingID = emptyToNil(in.GuestID), emptyToNil(in.BookingID)
	i.Photos = append([]json.RawMessage{}, in.Photos...)
}
