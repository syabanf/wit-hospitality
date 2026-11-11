package domain

import (
	"encoding/json"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Line is StockLine: an item and a count of pieces.
type Line struct {
	ItemID   string `json:"itemId"`
	Quantity int    `json:"quantity"`
}

// Positive keeps the lines with pieces in them, as the mock filters before it counts.
func Positive(lines []Line) []Line {
	out := []Line{}
	for _, l := range lines {
		if l.Quantity > 0 {
			out = append(out, l)
		}
	}
	return out
}

// Pieces totals the lines.
func Pieces(lines []Line) int {
	n := 0
	for _, l := range lines {
		n += l.Quantity
	}
	return n
}

// LinenPar is LinenPar: pieces of each item one room of a type holds, times sets per room.
type LinenPar struct {
	GroupID string `json:"groupId"`
	Sets    int    `json:"sets"`
	Lines   []Line `json:"lines"`
	Version int64  `json:"-"`
}

// ParInput is the body of PUT linen/pars/{groupId}.
type ParInput struct {
	Sets  int    `json:"sets"`
	Lines []Line `json:"lines"`
}

// ValidatePar is validateLinenPar.
func ValidatePar(in ParInput) error {
	var f errs.Fields
	if in.Sets < 1 || in.Sets > 6 {
		f.Add("sets", "Sets from 1 to 6.")
	}
	seen := map[string]bool{}
	bad, twice := false, false
	for _, l := range in.Lines {
		if l.ItemID == "" || l.Quantity < 1 {
			bad = true
		}
		if seen[l.ItemID] {
			twice = true
		}
		seen[l.ItemID] = true
	}
	if bad {
		f.Add("lines", "Whole pieces from 1 for each item.")
	} else if twice {
		f.Add("lines", "Add each item once.")
	}
	return f.Err()
}

// LinenCount is soiled linen a villa holds, waiting for the laundry.
type LinenCount struct {
	VillaID  string `json:"villaId"`
	ItemID   string `json:"itemId"`
	Quantity int    `json:"quantity"`
}

// Laundry batch statuses.
const (
	Out      = "out"
	Returned = "returned"
)

// LaundryLine is one item of a batch.
type LaundryLine struct {
	ItemID   string `json:"itemId"`
	Sent     int    `json:"sent"`
	Returned int    `json:"returned"`
	Damaged  int    `json:"damaged"`
}

// Missing is missingOf.
func (l LaundryLine) Missing() int { return max(0, l.Sent-l.Returned-l.Damaged) }

// LaundryBatch is LaundryBatch.
type LaundryBatch struct {
	ID            string            `json:"id"`
	Number        string            `json:"number"`
	VillaID       string            `json:"villaId"`
	Vendor        string            `json:"vendor"`
	Status        string            `json:"status"`
	SentOn        string            `json:"sentOn"`
	ReturnedOn    *string           `json:"returnedOn"`
	Lines         []LaundryLine     `json:"lines"`
	Cost          int64             `json:"cost"`
	Method        string            `json:"method"`
	Reference     string            `json:"reference"`
	Attachments   []json.RawMessage `json:"attachments"`
	TransactionID *string           `json:"transactionId"`
	WriteOffs     []string          `json:"writeOffs"`
	SentBy        string            `json:"sentBy"`
	ReturnedBy    string            `json:"returnedBy"`
	Note          string            `json:"note"`
	Version       int64             `json:"-"`
}

// Normalize turns absent lists into empty ones.
func (b *LaundryBatch) Normalize() {
	if b.Lines == nil {
		b.Lines = []LaundryLine{}
	}
	if b.Attachments == nil {
		b.Attachments = []json.RawMessage{}
	}
	if b.WriteOffs == nil {
		b.WriteOffs = []string{}
	}
}

// SendInput is LaundrySendInput.
type SendInput struct {
	VillaID string `json:"villaId"`
	Vendor  string `json:"vendor"`
	SentOn  string `json:"sentOn"`
	Lines   []Line `json:"lines"`
	Note    string `json:"note"`
}

// ValidateSend is validateLaundrySend.
func ValidateSend(in SendInput) error {
	var f errs.Fields
	if in.VillaID == "" {
		f.Add("villaId", "Pick the villa.")
	}
	if len([]rune(strings.TrimSpace(in.Vendor))) < 2 {
		f.Add("vendor", "Name the laundry.")
	}
	if !isoDay.MatchString(in.SentOn) {
		f.Add("sentOn", "Pick the day it left.")
	}
	if len(Positive(in.Lines)) == 0 {
		f.Add("lines", "Count at least one item.")
	}
	return f.Err()
}

// ReturnLine is what came back of one item.
type ReturnLine struct {
	ItemID   string `json:"itemId"`
	Returned int    `json:"returned"`
	Damaged  int    `json:"damaged"`
}

// ReturnInput is LaundryReturnInput.
type ReturnInput struct {
	ReturnedOn  string            `json:"returnedOn"`
	Lines       []ReturnLine      `json:"lines"`
	Cost        int64             `json:"cost"`
	Method      string            `json:"method"`
	Reference   string            `json:"reference"`
	Attachments []json.RawMessage `json:"attachments"`
}

// ValidateReturn is validateLaundryReturn.
func ValidateReturn(b LaundryBatch, in ReturnInput) error {
	var f errs.Fields
	if !isoDay.MatchString(in.ReturnedOn) {
		f.Add("returnedOn", "Pick the day it came back.")
	} else if in.ReturnedOn < b.SentOn {
		f.Add("returnedOn", "It came back before it left.")
	}
	lines := ""
	for _, l := range b.Lines {
		var back *ReturnLine
		for i := range in.Lines {
			if in.Lines[i].ItemID == l.ItemID {
				back = &in.Lines[i]
				break
			}
		}
		if back == nil || back.Returned < 0 || back.Damaged < 0 {
			lines = "Count what came back, whole pieces."
		} else if back.Returned+back.Damaged > l.Sent {
			lines = "More came back than was sent."
		}
	}
	if lines != "" {
		f.Add("lines", lines)
	}
	if in.Cost < 0 {
		f.Add("cost", "Whole rupiah, zero or more.")
	}
	if in.Method != "cash" && in.Method != "bank_transfer" {
		f.Add("method", "Pick how the laundry is paid.")
	}
	return f.Err()
}

// ApplyReturn records the counts on the batch and returns the pieces lost: missing plus damaged.
func ApplyReturn(b *LaundryBatch, in ReturnInput) []Line {
	lost := []Line{}
	for i, l := range b.Lines {
		l.Returned, l.Damaged = 0, 0
		for _, x := range in.Lines {
			if x.ItemID == l.ItemID {
				l.Returned, l.Damaged = x.Returned, x.Damaged
				break
			}
		}
		b.Lines[i] = l
		if n := l.Missing() + l.Damaged; n > 0 {
			lost = append(lost, Line{ItemID: l.ItemID, Quantity: n})
		}
	}
	return lost
}

// Discard is the body of POST linen/discards.
type Discard struct {
	VillaID string `json:"villaId"`
	From    string `json:"from"`
	Lines   []Line `json:"lines"`
	Reason  string `json:"reason"`
}

// ValidateDiscard is the service's check on a discard.
func ValidateDiscard(in Discard) error {
	var f errs.Fields
	if len(Positive(in.Lines)) == 0 {
		f.Add("lines", "Count what is discarded.")
	}
	if len([]rune(strings.TrimSpace(in.Reason))) < 3 {
		f.Add("reason", "Say why the linen is discarded.")
	}
	return f.Err()
}

// Item is a stock item as housekeeping names it.
type Item struct {
	ID   string `json:"id"`
	Code string `json:"code"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}
