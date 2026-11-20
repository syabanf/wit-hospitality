package domain

import (
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Unit inventory lists and checks, ported from src/domain/unitInventory.ts
// (api/docs/contracts/villa-operations-contract.md sections 1 and 2).

// InventoryCategories is INVENTORY_CATEGORIES.
var InventoryCategories = []string{"kitchen", "linen", "electronics", "furniture", "bathroom", "outdoor", "pool"}

// InventoryTrade is INVENTORY_TRADE: the maintenance category a damaged or missing item goes to.
var InventoryTrade = map[string]string{"kitchen": "appliance", "linen": "other", "electronics": "electrical", "furniture": "structure",
	"bathroom": "plumbing", "outdoor": "garden", "pool": "pool"}

// UnitItem is one item on a unit's inventory list.
type UnitItem struct {
	ID              string  `json:"id"`
	UnitID          string  `json:"unitId"`
	VillaID         string  `json:"villaId"`
	Name            string  `json:"name"`
	Category        string  `json:"category"`
	Expected        int64   `json:"expected"`
	Condition       string  `json:"condition"`
	Photo           *string `json:"photo"`
	ReplacementCost int64   `json:"replacementCost"`
}

// UnitItemInput is UnitItemInput.
type UnitItemInput struct {
	UnitID          string  `json:"unitId"`
	Name            string  `json:"name"`
	Category        string  `json:"category"`
	Expected        float64 `json:"expected"`
	Condition       string  `json:"condition"`
	Photo           *string `json:"photo"`
	ReplacementCost float64 `json:"replacementCost"`
}

const maxNote = 200

func wholeIn(n float64, lo, hi int64) bool { return whole(n) && n >= float64(lo) && n <= float64(hi) }

// ValidateUnitItem is validateUnitItem; list is the unit's items, current the item edited.
func ValidateUnitItem(in UnitItemInput, list []UnitItem, current *UnitItem) error {
	var f errs.Fields
	if current != nil && in.UnitID != current.UnitID {
		f.Add("unitId", "An item stays with its unit.")
	}
	name := strings.TrimSpace(in.Name)
	n := len([]rune(name))
	switch {
	case n < 2:
		f.Add("name", "Name the item.")
	case n > 60:
		f.Add("name", "An item name is at most 60 characters.")
	default:
		for _, i := range list {
			if (current == nil || i.ID != current.ID) && strings.EqualFold(i.Name, name) {
				f.Add("name", name+" is already on this list.")
				break
			}
		}
	}
	if !slices.Contains(InventoryCategories, in.Category) {
		f.Add("category", "Pick the category.")
	}
	if !wholeIn(in.Expected, 1, 999) {
		f.Add("expected", "A whole number from 1 to 999.")
	}
	if !whole(in.ReplacementCost) || in.ReplacementCost < 0 {
		f.Add("replacementCost", "Whole rupiah, zero or more.")
	}
	if len(in.Condition) > maxNote {
		f.Add("condition", "Keep the condition note under 200 characters.")
	}
	return f.Err()
}

// ItemsToCopy is itemsToCopy: the source's items whose names the target lacks.
func ItemsToCopy(source, target []UnitItem, sourceCode, targetCode string, sameUnit bool) ([]UnitItem, error) {
	if sameUnit {
		return nil, errs.New("INVENTORY_COPY_SELF", "Pick another unit to copy from.")
	}
	if len(source) == 0 {
		return nil, errs.New("INVENTORY_COPY_EMPTY", sourceCode+" has no inventory list to copy.")
	}
	taken := map[string]bool{}
	for _, i := range target {
		taken[strings.ToLower(i.Name)] = true
	}
	var fresh []UnitItem
	for _, i := range source {
		if !taken[strings.ToLower(i.Name)] {
			fresh = append(fresh, i)
		}
	}
	if len(fresh) == 0 {
		return nil, errs.New("INVENTORY_COPY_NOTHING", targetCode+" already lists every item of "+sourceCode+".")
	}
	return fresh, nil
}

// Check kinds and item conditions.
const (
	PreArrival    = "pre_arrival"
	PostDeparture = "post_departure"
)

// CheckKindLabel is CHECK_KIND_LABEL.
var CheckKindLabel = map[string]string{PreArrival: "Pre-arrival check", PostDeparture: "Post-departure check"}

// ItemConditions is ITEM_CONDITIONS.
var ItemConditions = []string{"ok", "damaged", "missing"}

// BookingStatusLabel is BOOKING_STATUS_LABEL.
var BookingStatusLabel = map[string]string{"draft": "Draft", "confirmed": "Confirmed", "checked_in": "Checked in", "checked_out": "Checked out",
	"cancelled": "Cancelled", "no_show": "No show"}

// LineCharge is what a line charged to the folio.
type LineCharge struct {
	SourceRef string `json:"sourceRef"`
	Quantity  int64  `json:"quantity"`
	Amount    int64  `json:"amount"`
	Reason    string `json:"reason"`
	By        string `json:"by"`
	On        string `json:"on"`
}

// LineWorkOrder names the work order a line raised.
type LineWorkOrder struct {
	ID     string `json:"id"`
	Number string `json:"number"`
}

// CheckLine is one counted item.
type CheckLine struct {
	ItemID          string         `json:"itemId"`
	Name            string         `json:"name"`
	Category        string         `json:"category"`
	Expected        int64          `json:"expected"`
	Counted         int64          `json:"counted"`
	Condition       string         `json:"condition"`
	Note            string         `json:"note"`
	ReplacementCost int64          `json:"replacementCost"`
	Charge          *LineCharge    `json:"charge"`
	WorkOrder       *LineWorkOrder `json:"workOrder"`
	Adjusted        bool           `json:"adjusted"`
}

// InventoryCheck is a pre-arrival or post-departure count of a unit's list.
type InventoryCheck struct {
	ID          string      `json:"id"`
	Number      string      `json:"number"`
	UnitID      string      `json:"unitId"`
	VillaID     string      `json:"villaId"`
	BookingID   string      `json:"bookingId"`
	BookingCode string      `json:"bookingCode"`
	Kind        string      `json:"kind"`
	On          string      `json:"on"`
	By          string      `json:"by"`
	ByID        string      `json:"byId"`
	Lines       []CheckLine `json:"lines"`
	Version     int64       `json:"-"`
}

// ItemCount is one counted line of a CheckInput.
type ItemCount struct {
	ItemID    string  `json:"itemId"`
	Counted   float64 `json:"counted"`
	Condition string  `json:"condition"`
	Note      string  `json:"note"`
}

// CheckInput is CheckInput.
type CheckInput struct {
	UnitID    string      `json:"unitId"`
	BookingID string      `json:"bookingId"`
	Kind      string      `json:"kind"`
	Lines     []ItemCount `json:"lines"`
}

// CheckStay is the stay as the check rules see it.
type CheckStay struct {
	ID     string
	Code   string
	Status string
	UnitID string
}

// CheckNumber is checkNumber.
func CheckNumber(n int) string { return fmt.Sprintf("IC-%d", 1000+n) }

var (
	stayOK   = map[string][]string{PreArrival: {"confirmed", "checked_in"}, PostDeparture: {"checked_in", "checked_out"}}
	stayWhen = map[string]string{PreArrival: "a pre-arrival check is for a stay arriving or in house", PostDeparture: "a post-departure check follows a stay in house or checked out"}
)

// ValidateCheck is validateCheck: the kind, the list, the stay, a second check of the kind, then the
// lines. `taken` reports whether the stay already has a check of the kind.
func ValidateCheck(in CheckInput, list []UnitItem, unitCode string, stay CheckStay, taken bool) error {
	if !slices.Contains([]string{PreArrival, PostDeparture}, in.Kind) {
		return errs.Invalid("kind", "Pick the check.")
	}
	if len(list) == 0 {
		return errs.New("CHECK_NO_LIST", unitCode+" has no inventory list yet; add its items first.")
	}
	if stay.UnitID != in.UnitID {
		return errs.Invalid("bookingId", "Pick a stay of this unit.")
	}
	if !slices.Contains(stayOK[in.Kind], stay.Status) {
		return errs.Newf("CHECK_STAY_STATE", "%s is %s; %s.", stay.Code, strings.ToLower(BookingStatusLabel[stay.Status]), stayWhen[in.Kind])
	}
	if taken {
		return errs.Newf("CHECK_TWICE", "%s already has a %s.", stay.Code, strings.ToLower(CheckKindLabel[in.Kind]))
	}
	seen := map[string]bool{}
	for _, l := range in.Lines {
		seen[l.ItemID] = true
	}
	complete := len(in.Lines) == len(list) && len(seen) == len(in.Lines)
	for _, i := range list {
		complete = complete && seen[i.ID]
	}
	if !complete {
		return errs.Invalid("lines", "Count every item on the list.")
	}
	var f errs.Fields
	for i, l := range in.Lines {
		item := itemOf(list, l.ItemID)
		switch {
		case !wholeIn(l.Counted, 0, 9999):
			f.Add(fmt.Sprintf("lines.%d.counted", i), "Count in whole numbers.")
		case !slices.Contains(ItemConditions, l.Condition):
			f.Add(fmt.Sprintf("lines.%d.condition", i), "Pick ok, damaged or missing.")
		case l.Condition == "ok" && int64(l.Counted) < item.Expected:
			f.Add(fmt.Sprintf("lines.%d.condition", i), fmt.Sprintf("%d of %d found; mark it missing or damaged.", int64(l.Counted), item.Expected))
		}
		if len(l.Note) > maxNote {
			f.Add(fmt.Sprintf("lines.%d.note", i), "Keep the note under 200 characters.")
		}
	}
	return f.Err()
}

func itemOf(list []UnitItem, id string) UnitItem {
	for _, i := range list {
		if i.ID == id {
			return i
		}
	}
	return UnitItem{}
}

// CheckLines is checkLines: each item's name, count and cost as they stood.
func CheckLines(in CheckInput, list []UnitItem) []CheckLine {
	out := make([]CheckLine, 0, len(in.Lines))
	for _, l := range in.Lines {
		item := itemOf(list, l.ItemID)
		out = append(out, CheckLine{ItemID: item.ID, Name: item.Name, Category: item.Category, Expected: item.Expected, Counted: int64(l.Counted),
			Condition: l.Condition, Note: strings.TrimSpace(l.Note), ReplacementCost: item.ReplacementCost})
	}
	return out
}

// LinesOff is linesOff.
func LinesOff(c InventoryCheck) int {
	n := 0
	for _, l := range c.Lines {
		if l.Condition != "ok" || l.Counted != l.Expected {
			n++
		}
	}
	return n
}

// Line finds a line by item id.
func (c *InventoryCheck) Line(itemID string) (*CheckLine, error) {
	for i := range c.Lines {
		if c.Lines[i].ItemID == itemID {
			return &c.Lines[i], nil
		}
	}
	return nil, errs.New(errs.CodeNotFound, c.Number+" has no such item.")
}

func assertLineOff(l CheckLine) error {
	if l.Condition == "ok" {
		return errs.New("CHECK_LINE_OK", l.Name+" was found in order.")
	}
	return nil
}

// ChargeInput is ChargeInput.
type ChargeInput struct {
	Quantity float64 `json:"quantity"`
	Reason   string  `json:"reason"`
}

// ValidateCharge is validateCharge; inHouse is whether the stay still takes folio charges.
func ValidateCharge(c InventoryCheck, l CheckLine, in ChargeInput, inHouse bool) error {
	if c.Kind != PostDeparture {
		return errs.New("CHECK_KIND", "Charges come from a post-departure check.")
	}
	if err := assertLineOff(l); err != nil {
		return err
	}
	if l.Charge != nil {
		return errs.Newf("CHECK_CHARGED", "%s is already charged to %s.", l.Name, c.BookingCode)
	}
	if l.ReplacementCost <= 0 {
		return errs.New("CHECK_NO_COST", l.Name+" has no replacement cost; set one on the list first.")
	}
	var f errs.Fields
	if !wholeIn(in.Quantity, 1, l.Expected) {
		f.Add("quantity", fmt.Sprintf("From 1 to %d.", l.Expected))
	}
	if len([]rune(strings.TrimSpace(in.Reason))) < 4 {
		f.Add("reason", "Say why the guest pays for it.")
	}
	if err := f.Err(); err != nil {
		return err
	}
	if !inHouse {
		return errs.Newf("CHECK_STAY_CLOSED", "%s has checked out; charge damage while the guest is in house, before the deposit is returned.", c.BookingCode)
	}
	return nil
}

func lineLabel(l CheckLine) string {
	if l.Condition == "missing" {
		return "Missing"
	}
	return "Damaged"
}

// ChargeDescription is chargeDescription.
func ChargeDescription(l CheckLine, quantity int64, reason string) string {
	return fmt.Sprintf("%s %s (%d): %s", lineLabel(l), l.Name, quantity, strings.TrimSpace(reason))
}

// AssertWorkOrderable is assertWorkOrderable.
func AssertWorkOrderable(l CheckLine) error {
	if err := assertLineOff(l); err != nil {
		return err
	}
	if l.WorkOrder != nil {
		return errs.Newf("CHECK_WORK_ORDER", "%s already has work order %s.", l.Name, l.WorkOrder.Number)
	}
	return nil
}

// AssertAdjustable is assertAdjustable.
func AssertAdjustable(l CheckLine) error {
	if err := assertLineOff(l); err != nil {
		return err
	}
	if l.Adjusted {
		return errs.New("CHECK_ADJUSTED", l.Name+" is already adjusted on the list.")
	}
	return nil
}

// LineJob is lineWorkOrder: the work order a damaged or missing item raises.
func LineJob(c InventoryCheck, l CheckLine, unitCode string) (category, title, description string) {
	description = fmt.Sprintf("%s, %s: %d of %d found", c.Number, CheckKindLabel[c.Kind], l.Counted, l.Expected)
	if l.Note != "" {
		description += ". " + l.Note
	}
	return InventoryTrade[l.Category], fmt.Sprintf("%s %s in %s", lineLabel(l), l.Name, unitCode), description
}
