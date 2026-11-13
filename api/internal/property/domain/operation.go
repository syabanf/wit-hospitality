package domain

import (
	"fmt"
	"slices"
	"unicode/utf8"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/property"
)

// How a property operates.
const (
	OperationVilla = "villa"
	OperationHotel = "hotel"
	OperationMixed = "mixed"
)

// Operations lists how a property may operate.
var Operations = []string{OperationVilla, OperationHotel, OperationMixed}

// Room type kinds; a unit's kind is its room type's.
const (
	KindRoom  = "room"
	KindVilla = "villa"
)

// MaxStayoverEvery is the longest gap in days between stayover cleans.
const MaxStayoverEvery = 7

// MaxFloor is the longest floor label in characters.
const MaxFloor = 10

// CodeGroupKind refuses a room type whose kind the property does not take.
const CodeGroupKind = "GROUP_KIND"

// Operating is how a villa runs: hotel, villa or both, how often a guest in house gets a stayover
// clean (0 is never), and whether the whole villa may be rented at once and for what nightly price
// (0 is the sum of its villa units' prices). DepositOnCheckIn asks a security deposit when a guest
// checks into a villa unit (into any unit of a hotel that sets it). LateCheckoutFee is what a room
// stay pays for a late check-out (a mixed property charges it on rooms only).
type Operating struct {
	Operation        string `json:"operation"`
	StayoverEvery    int    `json:"stayoverEvery"`
	WholeRental      bool   `json:"wholeRental"`
	WholeNightlyRate int64  `json:"wholeNightlyRate"`
	DepositOnCheckIn bool   `json:"depositOnCheckIn"`
	LateCheckoutFee  int64  `json:"lateCheckoutFee"`
}

// OperatingInput is the operation part of the villa form. An empty operation and fields left out
// keep the villa's; a new villa operates as a villa, with stayover cleans every day in a hotel or a
// mixed property, none in a villa, is not rented whole, asks a deposit at check-in unless it is a
// hotel, and charges property.DefaultLateCheckoutFee for a late check-out.
type OperatingInput struct {
	Operation        string   `json:"operation"`
	StayoverEvery    *float64 `json:"stayoverEvery"`
	WholeRental      *bool    `json:"wholeRental"`
	WholeNightlyRate *float64 `json:"wholeNightlyRate"`
	DepositOnCheckIn *bool    `json:"depositOnCheckIn"`
	LateCheckoutFee  *float64 `json:"lateCheckoutFee"`
}

// DefaultStayoverEvery is the stayover gap a property takes when the form leaves it out.
func DefaultStayoverEvery(operation string) int {
	if operation == OperationVilla {
		return 0
	}
	return 1
}

// DefaultMinStay is the minimum stay in nights a room type created through the wizard starts with:
// one for rooms, two for villas.
func DefaultMinStay(kind string) int {
	if kind == KindRoom {
		return 1
	}
	return 2
}

// DefaultDepositOnCheckIn is whether a property asks a deposit at check-in when the form leaves it
// out: not in a hotel.
func DefaultDepositOnCheckIn(operation string) bool { return operation != OperationHotel }

// DefaultKind is the kind of a room type the form leaves without one, and of a unit without a room
// type: rooms in a hotel, villas otherwise.
func DefaultKind(operation string) string {
	if operation == OperationHotel {
		return KindRoom
	}
	return KindVilla
}

// Keeping fills what the form leaves out with the villa's current operation.
func (in OperatingInput) Keeping(current Operating) OperatingInput {
	if in.Operation == "" {
		in.Operation = current.Operation
	}
	if in.Operation == current.Operation {
		if in.StayoverEvery == nil {
			every := float64(current.StayoverEvery)
			in.StayoverEvery = &every
		}
		if in.DepositOnCheckIn == nil {
			in.DepositOnCheckIn = &current.DepositOnCheckIn
		}
		if in.LateCheckoutFee == nil {
			fee := float64(current.LateCheckoutFee)
			in.LateCheckoutFee = &fee
		}
	}
	if in.WholeRental == nil {
		in.WholeRental = &current.WholeRental
	}
	if in.WholeNightlyRate == nil {
		rate := float64(current.WholeNightlyRate)
		in.WholeNightlyRate = &rate
	}
	return in
}

// resolved is the operation a valid form gives a villa.
func (in OperatingInput) resolved() Operating {
	o := Operating{Operation: in.Operation}
	if o.Operation == "" {
		o.Operation = OperationVilla
	}
	o.StayoverEvery = DefaultStayoverEvery(o.Operation)
	if in.StayoverEvery != nil {
		o.StayoverEvery = int(*in.StayoverEvery)
	}
	if in.WholeRental != nil {
		o.WholeRental = *in.WholeRental
	}
	if in.WholeNightlyRate != nil {
		o.WholeNightlyRate = int64(*in.WholeNightlyRate)
	}
	o.DepositOnCheckIn = DefaultDepositOnCheckIn(o.Operation)
	if in.DepositOnCheckIn != nil {
		o.DepositOnCheckIn = *in.DepositOnCheckIn
	}
	o.LateCheckoutFee = property.DefaultLateCheckoutFee(o.Operation)
	if in.LateCheckoutFee != nil {
		o.LateCheckoutFee = int64(*in.LateCheckoutFee)
	}
	return o
}

func operationFields(in OperatingInput, f *errs.Fields) {
	if in.Operation != "" && !slices.Contains(Operations, in.Operation) {
		f.Add("operation", "Pick villa, hotel, or hotel and villas.")
	}
	if e := in.StayoverEvery; e != nil && (!whole(*e) || *e < 0 || *e > MaxStayoverEvery) {
		f.Add("stayoverEvery", fmt.Sprintf("Stayover cleaning is every 0 to %d days; 0 is none.", MaxStayoverEvery))
	}
	if in.WholeRental != nil && *in.WholeRental && in.Operation == OperationHotel {
		f.Add("wholeRental", "A hotel is not rented whole.")
	}
	if r := in.WholeNightlyRate; r != nil && (!whole(*r) || *r < 0) {
		f.Add("wholeNightlyRate", "Enter the whole villa price in whole rupiah, or 0 for the sum of its units.")
	}
	if fee := in.LateCheckoutFee; fee != nil && (!whole(*fee) || *fee < 0) {
		f.Add("lateCheckoutFee", "Enter the late check-out fee in whole rupiah, or 0 for none.")
	}
}

// kindMessage is the GROUP_KIND message, or "" when the property takes the kind.
func kindMessage(kind, operation string) string {
	switch {
	case operation == OperationHotel && kind != KindRoom:
		return "A Hotel only has rooms."
	case operation == OperationVilla && kind != KindVilla:
		return "A Villa only has villas."
	}
	return ""
}

// kindFields checks a room type's kind against the property's operation; mismatch reports a
// GROUP_KIND refusal. An empty kind, still to take its default, and an empty operation, not yet
// known, pass.
func kindFields(kind, operation, field string, f *errs.Fields) (mismatch bool) {
	if kind == "" {
		return false
	}
	if kind != KindRoom && kind != KindVilla {
		f.Add(field, "Pick rooms or villas.")
		return false
	}
	if msg := kindMessage(kind, operation); msg != "" {
		f.Add(field, msg)
		return true
	}
	return false
}

// kindErr is f.Err() under the GROUP_KIND code when a kind did not fit the property.
func kindErr(f errs.Fields, mismatch bool) error {
	err := f.Err()
	if e, ok := errs.As(err); ok && mismatch {
		e.Code = CodeGroupKind
	}
	return err
}

// floorFields checks a unit's floor label.
func floorFields(floor, field string, f *errs.Fields) {
	if utf8.RuneCountInString(floor) > MaxFloor {
		f.Add(field, fmt.Sprintf("Keep the floor to %d characters, for example 2 or G.", MaxFloor))
	}
}

// FitKind is the kind a room type takes when its property changes to operation: a hotel's room
// types are rooms and a villa's are villas; in a mixed property each keeps its kind.
func FitKind(kind, operation string) string {
	if operation == OperationMixed {
		return kind
	}
	return DefaultKind(operation)
}
