// Package housekeeping is the published language of the housekeeping context: the events it
// publishes for inventory and finance. Payloads carry the villa and location, so a consumer acts on
// one event without calling back. Other contexts may import this package and nothing below it.
package housekeeping

import "encoding/json"

// Event types; the suffix is the payload version.
const (
	// EventRoomStateChanged follows every move on the board (dirty, cleaning, inspected, ready,
	// out of order), from the board, an inspection, a departure clean or a check-out.
	EventRoomStateChanged = "housekeeping.room.state_changed.v1"
	// EventRoomReleased follows a unit turning ready: inventory issues the room type's amenity kit
	// from the villa store (the mock's stock.issueKit).
	EventRoomReleased = "housekeeping.room.released.v1"
	// EventLinenDiscarded asks inventory to write linen off the villa store: a discard from soiled
	// or clean, or the missing and damaged pieces of a laundry batch.
	EventLinenDiscarded = "housekeeping.linen.discarded.v1"
	// EventLaundryBilled asks finance to book the laundry vendor's bill as a cash-out submitted for
	// approval (category cat-house, origin maintenance).
	EventLaundryBilled = "housekeeping.laundry.billed.v1"
)

// RoomState is the payload of room.state_changed.
type RoomState struct {
	UnitID     string `json:"unitId"`
	VillaID    string `json:"villaId"`
	LocationID string `json:"locationId"`
	From       string `json:"from"`
	To         string `json:"to"`
	On         string `json:"on"`
	By         string `json:"by"`
	Note       string `json:"note"`
}

// RoomReleased is the payload of room.released. GroupID is the room type whose kit applies; nil
// for a unit without one, which takes no kit.
type RoomReleased struct {
	UnitID     string  `json:"unitId"`
	UnitCode   string  `json:"unitCode"`
	GroupID    *string `json:"groupId"`
	VillaID    string  `json:"villaId"`
	LocationID string  `json:"locationId"`
	On         string  `json:"on"`
	By         string  `json:"by"`
	ByID       string  `json:"byId"`
}

// Line is one linen item and a count of pieces.
type Line struct {
	ItemID   string `json:"itemId"`
	Quantity int    `json:"quantity"`
}

// LinenDiscarded is the payload of linen.discarded. Inventory books one write-off movement per
// line, quantity negative, with Reason and Reference (the discard id, which the batch lists in
// writeOffs). From is soiled, clean or laundry.
type LinenDiscarded struct {
	DiscardID  string `json:"discardId"`
	VillaID    string `json:"villaId"`
	LocationID string `json:"locationId"`
	From       string `json:"from"`
	Lines      []Line `json:"lines"`
	Reason     string `json:"reason"`
	BatchID    string `json:"batchId,omitempty"`
	On         string `json:"on"`
	By         string `json:"by"`
	ByID       string `json:"byId"`
}

// LaundryBilled is the payload of laundry.billed. Finance picks the cashbox of the villa's location
// for cash (else the bank) and the bank for a transfer (else the cashbox), as the mock does.
type LaundryBilled struct {
	BatchID     string            `json:"batchId"`
	Number      string            `json:"number"`
	VillaID     string            `json:"villaId"`
	LocationID  string            `json:"locationId"`
	Vendor      string            `json:"vendor"`
	Amount      int64             `json:"amount"`
	Method      string            `json:"method"`
	Date        string            `json:"date"`
	CategoryID  string            `json:"categoryId"`
	Origin      string            `json:"origin"`
	Description string            `json:"description"`
	Reference   string            `json:"reference"`
	Attachments []json.RawMessage `json:"attachments"`
	By          string            `json:"by"`
	ByID        string            `json:"byId"`
}
