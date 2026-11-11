package domain

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Block reasons (BLOCK_REASONS).
var BlockReasons = []string{"maintenance", "owner", "cleaning", "other"}

// MaxNights is MAX_NIGHTS in booking.ts; a block follows the stay length rule.
const MaxNights = 90

// UnitBlock holds a unit off sale. To is exclusive, like a check-out.
type UnitBlock struct {
	ID     string `json:"id"`
	UnitID string `json:"unitId"`
	From   string `json:"from"`
	To     string `json:"to"`
	Reason string `json:"reason"`
	Note   string `json:"note"`
}

// BlockInput is a block without its id.
type BlockInput struct {
	UnitID string `json:"unitId"`
	From   string `json:"from"`
	To     string `json:"to"`
	Reason string `json:"reason"`
	Note   string `json:"note"`
}

var isoDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// ValidateBlock is the booking service's addBlock check: validateStay worded for a block.
func ValidateBlock(in BlockInput) error {
	var f errs.Fields
	if in.UnitID == "" {
		f.Add("unitId", "Pick the unit.")
	}
	if !isoDate.MatchString(in.From) || !isoDate.MatchString(in.To) {
		f.Add("to", "Pick both dates.")
	} else {
		from, errFrom := time.Parse("2006-01-02", in.From)
		to, errTo := time.Parse("2006-01-02", in.To)
		n := int(to.Sub(from).Hours() / 24)
		switch {
		case errFrom != nil || errTo != nil:
			f.Add("to", "Pick both dates.")
		case n < 1:
			f.Add("to", "The end must be after the start.")
		case n > MaxNights:
			f.Add("to", fmt.Sprintf("A stay is at most %d nights.", MaxNights))
		}
	}
	if !slices.Contains(BlockReasons, in.Reason) {
		f.Add("reason", "Pick a reason.")
	}
	return f.Err()
}

// NewBlock builds a block from a valid form.
func NewBlock(id string, in BlockInput) UnitBlock {
	return UnitBlock{ID: id, UnitID: in.UnitID, From: in.From, To: in.To, Reason: in.Reason, Note: strings.TrimSpace(in.Note)}
}

// ErrBlockOverlap refuses a block over a stay.
func ErrBlockOverlap(unitCode, stayCode string) error {
	return errs.Newf("BLOCK_OVERLAP", "%s has %s on those nights. Move it before blocking.", unitCode, stayCode)
}
