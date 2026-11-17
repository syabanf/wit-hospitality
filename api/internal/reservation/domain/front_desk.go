package domain

import (
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// The front desk's standard steps on a stay: the signed registration card, early check-in, the keys
// handed out and back, and wake-up calls. Each record sits in the booking document; the words and
// codes are src/domain/frontDesk.ts's (docs/contracts/front-desk-sop-contract.md).

// Attachment is a file the files context stored, as the client sends it back.
type Attachment struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Type       string `json:"type"`
	Size       int64  `json:"size"`
	URL        string `json:"url"`
	UploadedBy string `json:"uploadedBy"`
	UploadedAt string `json:"uploadedAt"`
}

// Card methods and the places a card is signed.
const (
	CardScreen     = "screen"
	CardPaper      = "paper"
	CardDesk       = "desk"
	CardPreCheckIn = "precheckin"
	CardStay       = "stay"
)

// RegistrationCard is the card the guest signed: a drawing on screen or a numbered paper card.
type RegistrationCard struct {
	Method     string      `json:"method"`
	Signature  *Attachment `json:"signature"`
	CardNumber string      `json:"cardNumber"`
	SignedAt   string      `json:"signedAt"`
	By         string      `json:"by"`
	Where      string      `json:"where"`
}

// CardInput is the body of POST /bookings/{id}/registration-card.
type CardInput struct {
	Method     string      `json:"method"`
	Signature  *Attachment `json:"signature"`
	CardNumber string      `json:"cardNumber"`
}

// MaxCardNumber and MaxKeyNumber are the longest numbers in characters.
const (
	MaxCardNumber = 30
	MaxKeyNumber  = 30
	MaxWakeNote   = 200
)

// ValidateRegistrationCard is validateRegistrationCard.
func ValidateRegistrationCard(in CardInput) error {
	switch in.Method {
	case CardScreen:
		if in.Signature == nil || in.Signature.ID == "" {
			return errs.Invalid("signature", "Ask the guest to sign on the screen.")
		}
		if !strings.HasPrefix(in.Signature.Type, "image/") {
			return errs.Invalid("signature", "The signature must be an image.")
		}
	case CardPaper:
		number := strings.TrimSpace(in.CardNumber)
		if number == "" {
			return errs.Invalid("cardNumber", "Enter the number printed on the paper card.")
		}
		if utf8.RuneCountInString(number) > MaxCardNumber {
			return errs.Invalid("cardNumber", fmt.Sprintf("A card number is at most %d characters.", MaxCardNumber))
		}
	default:
		return errs.Invalid("method", "Pick signed on screen or on paper.")
	}
	return nil
}

// SignCard puts the card on the stay in by's name: refused once the stay is over, on a bad input
// and on a stay that has a card (CARD_ALREADY_SIGNED).
func (b *Booking) SignCard(in CardInput, by, where, at string) error {
	if b.Over() {
		return ErrInvalidState("This stay is over; its registration card no longer changes.")
	}
	if err := ValidateRegistrationCard(in); err != nil {
		return err
	}
	if b.RegistrationCard != nil {
		return errs.Newf("CARD_ALREADY_SIGNED", "%s already has a signed registration card.", b.Code)
	}
	card := RegistrationCard{Method: in.Method, SignedAt: at, By: by, Where: where}
	if in.Method == CardScreen {
		sig := *in.Signature
		card.Signature = &sig
	} else {
		card.CardNumber = strings.TrimSpace(in.CardNumber)
	}
	b.RegistrationCard = &card
	return nil
}

// CardSummary words how the card was signed for the audit line.
func (c RegistrationCard) CardSummary() string {
	if c.Method == CardScreen {
		return "on screen"
	}
	return "on paper card " + c.CardNumber
}

// CheckCardSigned holds check-in for the card where the property asks for one.
func (b Booking) CheckCardSigned(required bool) error {
	if required && b.RegistrationCard == nil {
		return errs.New("REGISTRATION_CARD_UNSIGNED", "Have the guest sign the registration card before check-in.")
	}
	return nil
}

// EarlyCheckin is a granted early check-in: the time the guest may come in and what the folio was
// charged for it.
type EarlyCheckin struct {
	From   string `json:"from"`
	Charge int64  `json:"charge"`
	By     string `json:"by,omitempty"`
	At     string `json:"at,omitempty"`
}

// Departure is the stay leaving the unit on an arrival morning, as the early check-in rule reads it.
type Departure struct {
	Code       string
	LeavesBy   string
	CheckedOut bool
}

// EarlyCheckinRequest is what the early check-in rule reads.
type EarlyCheckinRequest struct {
	From        string
	CheckInTime string
	Kind        string
	Operation   string
	Fee         int64
	UnitCode    string
	Departure   *Departure
}

// CheckEarlyCheckinOpen is assertEarlyCheckinOpen: set once, before arrival, with the room known.
func (b Booking) CheckEarlyCheckinOpen() error {
	if b.Status != Confirmed {
		return ErrInvalidState(fmt.Sprintf("%s is %s; early check-in is set before arrival.", b.Code, spaced(b.Status)))
	}
	if b.EarlyCheckin != nil {
		return ErrInvalidState(fmt.Sprintf("%s already arrives early, from %s.", b.Code, b.EarlyCheckin.From))
	}
	if !b.UnitAssigned {
		return errs.Newf("UNIT_UNASSIGNED", "Assign a room to %s before setting early check-in.", b.Code)
	}
	return nil
}

// EarlyCheckinCharge is earlyCheckinCharge: a room pays the fee, a villa comes in free when nobody
// left it that morning, a mixed property never charges its villas; EARLY_CHECKIN_TAKEN while the
// departing guest still holds the unit past From.
func EarlyCheckinCharge(r EarlyCheckinRequest) (int64, error) {
	if !clockTimeRe.MatchString(r.From) {
		return 0, errs.Invalid("from", "Enter the time the guest arrives as HH:MM.")
	}
	house := r.CheckInTime
	if house == "" {
		house = DefaultCheckInTime
	}
	if r.From >= house {
		return 0, errs.Invalid("from", fmt.Sprintf("Check-in is from %s anyway; early check-in comes before it.", house))
	}
	if d := r.Departure; d != nil && !d.CheckedOut && d.LeavesBy > r.From {
		return 0, errs.Newf("EARLY_CHECKIN_TAKEN", "%s still holds %s until %s.", d.Code, r.UnitCode, d.LeavesBy)
	}
	switch {
	case r.Kind == KindRoom:
		return r.Fee, nil
	case r.Departure == nil || r.Operation == OperationMixed:
		return 0, nil
	}
	return r.Fee, nil
}

// DepartureOf is the stay among stays that leaves b's unit on b's arrival morning, or nil.
func DepartureOf(b Booking, stays []Booking, checkOutTime string) *Departure {
	if checkOutTime == "" {
		checkOutTime = DefaultCheckOutTime
	}
	for _, x := range stays {
		if x.ID == b.ID || !x.UnitAssigned || x.UnitID != b.UnitID || x.CheckOut != b.CheckIn || x.Status == Cancelled || x.Status == NoShow || x.Status == Draft {
			continue
		}
		leaves := checkOutTime
		if x.LateCheckout != nil {
			leaves = x.LateCheckout.Until
		}
		return &Departure{Code: x.Code, LeavesBy: leaves, CheckedOut: x.Status == CheckedOut}
	}
	return nil
}

// Key kinds, reasons and states.
const (
	KeyCard = "card"
	KeyKey  = "key"
	KeyCode = "code"

	KeyAtCheckIn   = "check_in"
	KeyExtra       = "extra"
	KeyReplacement = "replacement"

	KeyOut         = "out"
	KeyReturned    = "returned"
	KeyLost        = "lost"
	KeyNotReturned = "not_returned"
)

// KeyKinds is KEY_KINDS.
var KeyKinds = []string{KeyCard, KeyKey, KeyCode}

// KeyHanded is a key handed over at check-in.
type KeyHanded struct {
	Number string `json:"number"`
	Kind   string `json:"kind"`
}

// StayKey is one key handed out for a stay and what became of it.
type StayKey struct {
	ID       string  `json:"id"`
	Number   string  `json:"number"`
	Kind     string  `json:"kind"`
	Reason   string  `json:"reason"`
	Replaces *string `json:"replaces"`
	IssuedAt string  `json:"issuedAt"`
	IssuedBy string  `json:"issuedBy"`
	Status   string  `json:"status"`
	ClosedAt *string `json:"closedAt"`
	ClosedBy *string `json:"closedBy"`
	Charge   int64   `json:"charge"`
}

// IssueKeyInput is the body of POST /bookings/{id}/keys.
type IssueKeyInput struct {
	Number        string   `json:"number"`
	Kind          string   `json:"kind"`
	Reason        string   `json:"reason"`
	ReplacesKeyID *string  `json:"replacesKeyId"`
	Fee           *float64 `json:"fee"`
}

// ReturnKeyInput is the body of POST /bookings/{id}/keys/{keyId}/return.
type ReturnKeyInput struct {
	Returned bool     `json:"returned"`
	Fee      *float64 `json:"fee"`
}

// KeysOut are the keys still with the guest.
func (b Booking) KeysOut() []StayKey {
	var out []StayKey
	for _, k := range b.Keys {
		if k.Status == KeyOut {
			out = append(out, k)
		}
	}
	return out
}

// keyProblems adds the first problem of a key's number and kind; taken are the numbers already out.
func keyProblems(number, kind string, taken []string, f *errs.Fields, numberField, kindField string) {
	number = strings.TrimSpace(number)
	switch {
	case number == "":
		f.Add(numberField, "Enter the key number, card id or code.")
	case utf8.RuneCountInString(number) > MaxKeyNumber:
		f.Add(numberField, fmt.Sprintf("A key number is at most %d characters.", MaxKeyNumber))
	case slices.ContainsFunc(taken, func(t string) bool { return strings.EqualFold(t, number) }):
		f.Add(numberField, number+" is already out on this stay.")
	}
	if !slices.Contains(KeyKinds, kind) {
		f.Add(kindField, "Pick a key card, a physical key or an access code.")
	}
}

func feeProblem(fee *float64, f *errs.Fields) {
	if fee != nil && (!whole(*fee) || *fee < 0) {
		f.Add("fee", "Enter the fee in whole rupiah, or zero.")
	}
}

// CheckInKeysProblem is validateCheckInKeys: at least one key, or the older keysHanded tick; ""
// when the keys are fine.
func CheckInKeysProblem(keys []KeyHanded, keysHanded bool, unitKind string) string {
	if len(keys) == 0 {
		switch {
		case keysHanded:
			return ""
		case unitKind == KindRoom:
			return "Record the room key card handed over."
		}
		return "Record the keys or access code handed over."
	}
	var taken []string
	for _, k := range keys {
		var f errs.Fields
		keyProblems(k.Number, k.Kind, taken, &f, "keys", "keys")
		if len(f) > 0 {
			return f[0].Message
		}
		taken = append(taken, strings.TrimSpace(k.Number))
	}
	return ""
}

// ValidateIssueKey is validateIssueKey against the keys out on the stay.
func (b Booking) ValidateIssueKey(in IssueKeyInput) error {
	var f errs.Fields
	out := b.KeysOut()
	taken := make([]string, 0, len(out))
	for _, k := range out {
		taken = append(taken, k.Number)
	}
	keyProblems(in.Number, in.Kind, taken, &f, "number", "kind")
	if in.Reason != KeyExtra && in.Reason != KeyReplacement {
		f.Add("reason", "Pick why the key goes out.")
	}
	if in.Reason == KeyReplacement && !slices.ContainsFunc(out, func(k StayKey) bool { return in.ReplacesKeyID != nil && k.ID == *in.ReplacesKeyID }) {
		f.Add("replacesKeyId", "Pick the key this one replaces.")
	}
	feeProblem(in.Fee, &f)
	return f.Err()
}

// ValidateReturnFee checks the fee of a key not returned.
func ValidateReturnFee(fee *float64) error {
	var f errs.Fields
	feeProblem(fee, &f)
	return f.Err()
}

// CheckKeysOpen refuses keys going out or back on a stay not in house.
func (b Booking) CheckKeysOpen() error {
	if b.Status != CheckedIn {
		return ErrInvalidState(fmt.Sprintf("%s is not in house; keys go out at check-in and during the stay.", b.Code))
	}
	return nil
}

// AddKey hands a new key out on the stay.
func (b *Booking) AddKey(k KeyHanded, reason string, replaces *string, by, at string) StayKey {
	key := StayKey{ID: fmt.Sprintf("key-%d", len(b.Keys)+1), Number: strings.TrimSpace(k.Number), Kind: k.Kind, Reason: reason, Replaces: replaces,
		IssuedAt: at, IssuedBy: by, Status: KeyOut}
	b.Keys = append(b.Keys, key)
	return key
}

// CloseKey closes a key that is out: NOT_FOUND for an unknown key, KEY_NOT_OUT for one closed.
func (b *Booking) CloseKey(id, status string, charge int64, by, at string) (StayKey, error) {
	for i, k := range b.Keys {
		if k.ID != id {
			continue
		}
		if k.Status != KeyOut {
			return k, errs.Newf("KEY_NOT_OUT", "%s is not out.", k.Number)
		}
		k.Status, k.Charge, k.ClosedAt, k.ClosedBy = status, charge, &at, &by
		b.Keys[i] = k
		return k, nil
	}
	return StayKey{}, errs.New("NOT_FOUND", "That key was not found on this stay.")
}

// KeyChargeDescription is the folio line a key's fee posts with.
func (k StayKey) KeyChargeDescription() string {
	if k.Status == KeyLost {
		return "Lost key " + k.Number
	}
	return "Key not returned: " + k.Number
}

// KeysAllBack is keysAllBack: none closed not returned, or ticked on a stay without key records.
func (b Booking) KeysAllBack(ticked bool) bool {
	if len(b.Keys) == 0 {
		return ticked
	}
	return !slices.ContainsFunc(b.Keys, func(k StayKey) bool { return k.Status == KeyNotReturned })
}

// Wake-up call states and outcomes.
const (
	WakePending   = "pending"
	WakeDone      = "done"
	WakeCancelled = "cancelled"
	WakeNoAnswer  = "no_answer"
	// SystemActor closes what a stay leaves behind when it ends.
	SystemActor = "System"
)

// WakeUpLog is one try of a wake-up call.
type WakeUpLog struct {
	Date    string `json:"date"`
	Outcome string `json:"outcome"`
	By      string `json:"by"`
	At      string `json:"at"`
}

// WakeUpCall is a call the desk makes on a morning of the stay; a daily one rolls on until
// check-out.
type WakeUpCall struct {
	ID          string      `json:"id"`
	Date        string      `json:"date"`
	Time        string      `json:"time"`
	Note        string      `json:"note"`
	RepeatDaily bool        `json:"repeatDaily"`
	Status      string      `json:"status"`
	By          string      `json:"by"`
	At          string      `json:"at"`
	Log         []WakeUpLog `json:"log"`
}

// WakeUpInput is the body that books a call.
type WakeUpInput struct {
	Date        string `json:"date"`
	Time        string `json:"time"`
	Note        string `json:"note"`
	RepeatDaily bool   `json:"repeatDaily"`
}

// OutcomeInput is the body that records a call's outcome.
type OutcomeInput struct {
	Outcome string `json:"outcome"`
}

// CheckWakeUpOpen refuses a change to the calls of a stay that is over.
func (b Booking) CheckWakeUpOpen() error {
	if b.Over() {
		return ErrInvalidState("This stay is over; its wake-up calls no longer change.")
	}
	return nil
}

// ValidateWakeUp is validateWakeUp: a morning of the stay, today or later, a clock time, a short note.
func (b Booking) ValidateWakeUp(in WakeUpInput, today string) error {
	var f errs.Fields
	switch {
	case !isoDate.MatchString(in.Date) || in.Date < b.CheckIn || in.Date > b.CheckOut:
		f.Add("date", fmt.Sprintf("Pick a day of the stay, from %s to %s.", b.CheckIn, b.CheckOut))
	case in.Date < today:
		f.Add("date", "Pick today or a later day.")
	}
	if !clockTimeRe.MatchString(in.Time) {
		f.Add("time", "Enter the time as HH:MM.")
	}
	if utf8.RuneCountInString(strings.TrimSpace(in.Note)) > MaxWakeNote {
		f.Add("note", fmt.Sprintf("Keep the note to %d characters.", MaxWakeNote))
	}
	return f.Err()
}

// AddWakeUp books a call on the stay.
func (b *Booking) AddWakeUp(in WakeUpInput, by, at string) WakeUpCall {
	call := WakeUpCall{ID: fmt.Sprintf("wk-%d", len(b.WakeUpCalls)+1), Date: in.Date, Time: in.Time, Note: strings.TrimSpace(in.Note),
		RepeatDaily: in.RepeatDaily, Status: WakePending, By: by, At: at, Log: []WakeUpLog{}}
	b.WakeUpCalls = append(b.WakeUpCalls, call)
	return call
}

// WakeUpAfter is wakeUpAfter: done rolls a daily call to the next morning until check-out, no answer
// keeps it pending, cancel ends it; a call not pending refuses (WAKE_UP_CLOSED).
func (b *Booking) WakeUpAfter(id, outcome, by, at string) (WakeUpCall, error) {
	if outcome != WakeDone && outcome != WakeNoAnswer && outcome != WakeCancelled {
		return WakeUpCall{}, errs.Invalid("outcome", "Pick done, no answer or cancel.")
	}
	for i, c := range b.WakeUpCalls {
		if c.ID != id {
			continue
		}
		if c.Status != WakePending {
			return c, errs.Newf("WAKE_UP_CLOSED", "This wake-up call is %s already.", c.Status)
		}
		before := c
		c.Log = append(slices.Clone(c.Log), WakeUpLog{Date: c.Date, Outcome: outcome, By: by, At: at})
		switch outcome {
		case WakeCancelled:
			c.Status = WakeCancelled
		case WakeDone:
			if next := AddDays(c.Date, 1); c.RepeatDaily && next <= b.CheckOut {
				c.Date = next
			} else {
				c.Status = WakeDone
			}
		}
		b.WakeUpCalls[i] = c
		return before, nil
	}
	return WakeUpCall{}, errs.New("NOT_FOUND", "That wake-up call was not found on this stay.")
}

// EndStay closes the keys still out as not returned and cancels the pending calls, as a stay that
// ends does; it answers whether the keys came back (KeysAllBack).
func (b *Booking) EndStay(by, at string, ticked bool) bool {
	for i, k := range b.Keys {
		if k.Status == KeyOut {
			k.Status, k.ClosedAt, k.ClosedBy = KeyNotReturned, &at, &by
			b.Keys[i] = k
		}
	}
	for i, c := range b.WakeUpCalls {
		if c.Status == WakePending {
			c.Status = WakeCancelled
			c.Log = append(slices.Clone(c.Log), WakeUpLog{Date: c.Date, Outcome: WakeCancelled, By: SystemActor, At: at})
			b.WakeUpCalls[i] = c
		}
	}
	return b.KeysAllBack(ticked)
}
