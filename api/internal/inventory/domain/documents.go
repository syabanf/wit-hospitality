package domain

import (
	"sort"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Attachment is a stored file reference. The files context owns the bytes.
type Attachment struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Type       string `json:"type"`
	Size       int64  `json:"size"`
	URL        string `json:"url"`
	UploadedBy string `json:"uploadedBy"`
	UploadedAt string `json:"uploadedAt"`
}

// StockReceipt is goods bought into a villa store; the purchase is a cash-out through approval.
type StockReceipt struct {
	ID            string        `json:"id"`
	Number        string        `json:"number"`
	VillaID       string        `json:"villaId"`
	Supplier      string        `json:"supplier"`
	Lines         []ReceiptLine `json:"lines"`
	Method        string        `json:"method"`
	Reference     string        `json:"reference"`
	Attachments   []Attachment  `json:"attachments"`
	ReceivedOn    string        `json:"receivedOn"`
	TransactionID *string       `json:"transactionId"`
	CreatedBy     string        `json:"createdBy"`
	CreatedOn     string        `json:"createdOn"`
	CancelledOn   *string       `json:"cancelledOn,omitempty"`
	Version       int64         `json:"-"`
}

// ReceiptInput is ReceiptInput.
type ReceiptInput struct {
	VillaID     string             `json:"villaId"`
	Supplier    string             `json:"supplier"`
	Lines       []ReceiptLineInput `json:"lines"`
	Method      string             `json:"method"`
	Reference   string             `json:"reference"`
	Attachments []Attachment       `json:"attachments"`
	ReceivedOn  string             `json:"receivedOn"`
}

// Total is receiptTotal.
func (r StockReceipt) Total() int64 { return ReceiptTotal(r.Lines) }

// ReceiptTotal adds up the lines.
func ReceiptTotal(lines []ReceiptLine) int64 {
	var s int64
	for _, l := range lines {
		s += Round(float64(l.Quantity) * float64(l.UnitCost))
	}
	return s
}

// ValidateReceipt is validateReceipt.
func ValidateReceipt(in ReceiptInput) error {
	var f errs.Fields
	if in.VillaID == "" {
		f.Add("villaId", "Pick the villa store.")
	}
	if len([]rune(strings.TrimSpace(in.Supplier))) < 2 {
		f.Add("supplier", "Name the shop or supplier.")
	}
	plain := make([]LineInput, 0, len(in.Lines))
	priced := true
	for _, l := range in.Lines {
		plain = append(plain, LineInput{ItemID: l.ItemID, Quantity: l.Quantity})
		if !wholeAtLeast(l.UnitCost, 1) {
			priced = false
		}
	}
	if !validLines(plain) {
		f.Add("lines", "Add each item once, in whole quantities from 1.")
	} else if !priced {
		f.Add("lines", "Enter what each item cost, in whole rupiah.")
	}
	if in.Method != "cash" && in.Method != "bank_transfer" {
		f.Add("method", "Pick how it was paid.")
	}
	if !isoDate.MatchString(in.ReceivedOn) {
		f.Add("receivedOn", "Pick the day the goods arrived.")
	}
	return f.Err()
}

// ReceiptLines converts valid form lines.
func ReceiptLines(in []ReceiptLineInput) []ReceiptLine {
	out := make([]ReceiptLine, 0, len(in))
	for _, l := range in {
		out = append(out, ReceiptLine{ItemID: l.ItemID, Quantity: int(l.Quantity), UnitCost: int64(l.UnitCost)})
	}
	return out
}

// MoveInput is MoveInput: issue to a unit, transfer to another villa store, or write off.
type MoveInput struct {
	Kind      string      `json:"kind"`
	VillaID   string      `json:"villaId"`
	UnitID    *string     `json:"unitId"`
	ToVillaID *string     `json:"toVillaId"`
	Lines     []LineInput `json:"lines"`
	Reason    string      `json:"reason"`
}

func blank(s *string) bool { return s == nil || *s == "" }

// ValidateMove is validateMove.
func ValidateMove(in MoveInput) error {
	var f errs.Fields
	if in.VillaID == "" {
		f.Add("villaId", "Pick the villa store.")
	}
	if !validLines(in.Lines) {
		f.Add("lines", "Add each item once, in whole quantities from 1.")
	}
	if in.Kind == Issue && blank(in.UnitID) {
		f.Add("unitId", "Pick the unit.")
	}
	if in.Kind == Transfer {
		if blank(in.ToVillaID) {
			f.Add("toVillaId", "Pick the store it goes to.")
		} else if *in.ToVillaID == in.VillaID {
			f.Add("toVillaId", "Pick another villa.")
		}
	}
	if in.Kind == WriteOff && len([]rune(strings.TrimSpace(in.Reason))) < 3 {
		f.Add("reason", "Say why the stock is written off.")
	}
	return f.Err()
}

// CountLine is one counted item.
type CountLine struct {
	ItemID   string `json:"itemId"`
	Expected int    `json:"expected"`
	Counted  int    `json:"counted"`
	UnitCost int64  `json:"unitCost"`
}

// Count is StockCount: a shelf count of one villa store.
type Count struct {
	ID        string      `json:"id"`
	Number    string      `json:"number"`
	VillaID   string      `json:"villaId"`
	CountedBy string      `json:"countedBy"`
	CountedOn string      `json:"countedOn"`
	Lines     []CountLine `json:"lines"`
	Note      string      `json:"note"`
}

// CountInput is CountInput.
type CountInput struct {
	VillaID   string           `json:"villaId"`
	CountedBy string           `json:"countedBy"`
	Lines     []CountLineInput `json:"lines"`
	Note      string           `json:"note"`
}

// CountLineInput is one counted item as the form sends it.
type CountLineInput struct {
	ItemID  string  `json:"itemId"`
	Counted float64 `json:"counted"`
}

// ValidateCount is validateCount.
func ValidateCount(in CountInput) error {
	var f errs.Fields
	if in.VillaID == "" {
		f.Add("villaId", "Pick the villa store.")
	}
	if len([]rune(strings.TrimSpace(in.CountedBy))) < 2 {
		f.Add("countedBy", "Name who counted.")
	}
	if len(in.Lines) == 0 {
		f.Add("lines", "Count at least one item.")
	} else {
		for _, l := range in.Lines {
			if !wholeAtLeast(l.Counted, 0) {
				f.Add("lines", "Counts are whole numbers, zero or more.")
				break
			}
		}
	}
	return f.Err()
}

// Variance is lineVariance.
func (l CountLine) Variance() int { return l.Counted - l.Expected }

// VarianceValue is varianceValue: each difference at the cost the line was counted at.
func (c Count) VarianceValue() int64 {
	var s int64
	for _, l := range c.Lines {
		s += Round(float64(l.Variance()) * float64(l.UnitCost))
	}
	return s
}

// Kit is AmenityKit: what one room type gets after every turnover.
type Kit struct {
	GroupID string `json:"groupId"`
	Lines   []Line `json:"lines"`
}

// ValidateKit is validateKit: an empty kit is allowed and removes it.
func ValidateKit(lines []LineInput) error {
	if len(lines) == 0 || validLines(lines) {
		return nil
	}
	return errs.Invalid("lines", "Add each item once, in whole quantities from 1.")
}

// KitIssue is kitIssue: what a kit takes from a store that may be short.
func KitIssue(kit Kit, held func(itemID string) int) (issue, short []Line) {
	issue, short = []Line{}, []Line{}
	for _, l := range kit.Lines {
		take := min(l.Quantity, max(0, held(l.ItemID)))
		if take > 0 {
			issue = append(issue, Line{ItemID: l.ItemID, Quantity: take})
		}
		if take < l.Quantity {
			short = append(short, Line{ItemID: l.ItemID, Quantity: l.Quantity - take})
		}
	}
	return issue, short
}

// MinibarLink ties a minibar menu item to the stock item it sells.
type MinibarLink struct {
	MenuItemID  string `json:"menuItemId"`
	StockItemID string `json:"stockItemId"`
}

// MinibarCheckInput is MinibarCheckInput: what the guest took from the in-room minibar.
type MinibarCheckInput struct {
	BookingID string             `json:"bookingId"`
	Lines     []MinibarLineInput `json:"lines"`
	Restock   bool               `json:"restock"`
	Note      string             `json:"note"`
}

// MinibarLineInput is one minibar menu item and how many the guest took.
type MinibarLineInput struct {
	MenuItemID string  `json:"menuItemId"`
	Quantity   float64 `json:"quantity"`
}

// ValidateMinibarCheck is validateMinibarCheck.
func ValidateMinibarCheck(in MinibarCheckInput) error {
	taken := 0
	for _, l := range in.Lines {
		if l.Quantity > 0 {
			taken++
			if !wholeAtLeast(l.Quantity, 1) || l.Quantity > 50 {
				return errs.Invalid("lines", "Whole quantities from 1 to 50.")
			}
		}
	}
	if taken == 0 {
		return errs.Invalid("lines", "Enter what the guest took.")
	}
	return nil
}

// SortMovements is sortMovements: newest first; inside a day, the latest number on top.
func SortMovements(list []Movement) []Movement {
	out := append([]Movement(nil), list...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].On != out[j].On {
			return out[i].On > out[j].On
		}
		return CompareNumbers(out[i].Number, out[j].Number) > 0
	})
	return out
}
