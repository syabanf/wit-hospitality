package domain

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Guest relations: complaints, incidents and safe deposit boxes, ported from
// src/domain/relations.ts with the codes and wording of api/docs/contracts/guest-relations-contract.md.

// CompensationLimit is COMPENSATION_LIMIT: a folio credit above it waits for someone who may
// approve in the guest module.
const CompensationLimit int64 = 500_000

// MaxAttachments is MAX_ATTACHMENTS.
const MaxAttachments = 10

// MaxSignatureData bounds a drawn signature's PNG data URL.
const MaxSignatureData = 200_000

var isoMinute = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$`)

func short(s string, n int) bool { return len([]rune(strings.TrimSpace(s))) < n }

func set(s *string) bool { return s != nil && *s != "" }

// validMinute adds the field error of a `YYYY-MM-DDTHH:MM` time that is missing or after today.
func validMinute(f *errs.Fields, field, value, missing, today string) {
	switch {
	case !isoMinute.MatchString(value):
		f.Add(field, missing)
	case value[:10] > today:
		f.Add(field, "The time cannot be in the future.")
	}
}

// ComplaintCategoryLabel names the complaint categories.
var ComplaintCategoryLabel = map[string]string{
	"room": "Room", "cleanliness": "Cleanliness", "noise": "Noise", "service": "Service", "food": "Food and drinks",
	"billing": "Billing", "staff": "Staff", "facility": "Facilities", "other": "Other",
}

// SeverityLabel names the severities.
var SeverityLabel = map[string]string{"low": "Low", "medium": "Medium", "high": "High"}

// ComplaintStatusLabel names the complaint statuses.
var ComplaintStatusLabel = map[string]string{"open": "Open", "in_progress": "In progress", "resolved": "Resolved", "closed": "Closed"}

// ComplaintTransitions is COMPLAINT_TRANSITIONS.
var ComplaintTransitions = map[string][]string{
	"open":        {"in_progress", "resolved"},
	"in_progress": {"resolved"},
	"resolved":    {"closed", "in_progress"},
	"closed":      {},
}

// CompensationKindLabel names the compensation kinds.
var CompensationKindLabel = map[string]string{"folio_credit": "Folio credit", "free_service": "Free service", "goodwill": "Goodwill gesture"}

// Link is a work order or housekeeping task raised from a complaint.
type Link struct {
	Kind  string `json:"kind"`
	ID    string `json:"id"`
	Label string `json:"label"`
}

// ComplaintEntry is one line of a complaint's timeline.
type ComplaintEntry struct {
	At   string `json:"at"`
	By   string `json:"by"`
	Kind string `json:"kind"`
	Note string `json:"note"`
	Ref  *Link  `json:"ref"`
}

// Resolution is what was done.
type Resolution struct {
	Action string `json:"action"`
	By     string `json:"by"`
	At     string `json:"at"`
}

// Compensation is what the guest got.
type Compensation struct {
	Kind        string  `json:"kind"`
	Amount      int64   `json:"amount"`
	Description string  `json:"description"`
	Status      string  `json:"status"`
	DecidedBy   *string `json:"decidedBy"`
	DecidedAt   *string `json:"decidedAt"`
}

// Complaint is a guest's complaint about a stay or the property.
type Complaint struct {
	ID           string           `json:"id"`
	Number       string           `json:"number"`
	VillaID      string           `json:"villaId"`
	UnitID       *string          `json:"unitId"`
	BookingID    *string          `json:"bookingId"`
	GuestID      string           `json:"guestId"`
	Category     string           `json:"category"`
	Severity     string           `json:"severity"`
	Description  string           `json:"description"`
	ReceivedBy   string           `json:"receivedBy"`
	ReceivedAt   string           `json:"receivedAt"`
	Owner        string           `json:"owner"`
	Source       string           `json:"source"`
	Status       string           `json:"status"`
	Resolution   *Resolution      `json:"resolution"`
	Compensation *Compensation    `json:"compensation"`
	Links        []Link           `json:"links"`
	Timeline     []ComplaintEntry `json:"timeline"`
	Version      int64            `json:"-"`
}

// ComplaintInput is ComplaintInput.
type ComplaintInput struct {
	VillaID     string  `json:"villaId"`
	UnitID      *string `json:"unitId"`
	BookingID   *string `json:"bookingId"`
	GuestID     *string `json:"guestId"`
	Category    string  `json:"category"`
	Severity    string  `json:"severity"`
	Description string  `json:"description"`
	ReceivedBy  string  `json:"receivedBy"`
	ReceivedAt  string  `json:"receivedAt"`
	Owner       string  `json:"owner"`
}

// ValidateComplaint is validateComplaint, in its field order.
func ValidateComplaint(in ComplaintInput, today string) error {
	var f errs.Fields
	if in.VillaID == "" {
		f.Add("villaId", "Pick the villa.")
	}
	if !set(in.GuestID) && !set(in.BookingID) {
		f.Add("guestId", "Pick the guest or the stay.")
	}
	if _, ok := ComplaintCategoryLabel[in.Category]; !ok {
		f.Add("category", "Pick the category.")
	}
	if _, ok := SeverityLabel[in.Severity]; !ok {
		f.Add("severity", "Pick the severity.")
	}
	if short(in.Description, 5) {
		f.Add("description", "Write what the guest said.")
	}
	if short(in.ReceivedBy, 2) {
		f.Add("receivedBy", "Say who received it.")
	}
	validMinute(&f, "receivedAt", in.ReceivedAt, "Enter when it was received.", today)
	if short(in.Owner, 2) {
		f.Add("owner", "Name who follows it up.")
	}
	return f.Err()
}

// Apply sets the cleaned input; the stay's villa, unit and guest are already filled in.
func (c *Complaint) Apply(in ComplaintInput) {
	c.VillaID, c.UnitID, c.BookingID = in.VillaID, emptyToNil(in.UnitID), emptyToNil(in.BookingID)
	if in.GuestID != nil {
		c.GuestID = *in.GuestID
	}
	c.Category, c.Severity = in.Category, in.Severity
	c.Description, c.ReceivedBy, c.Owner = strings.TrimSpace(in.Description), strings.TrimSpace(in.ReceivedBy), strings.TrimSpace(in.Owner)
	c.ReceivedAt = in.ReceivedAt
}

func complaintRefused(msg string) error { return errs.New("COMPLAINT_INVALID_STATE", msg) }

// CheckComplaintOpen refuses a change to a closed complaint.
func CheckComplaintOpen(c Complaint) error {
	if c.Status == "closed" {
		return complaintRefused(c.Number + " is closed.")
	}
	return nil
}

func cannotBecome(c Complaint, to string) error {
	label := ComplaintStatusLabel[to]
	if label == "" {
		label = to
	}
	return complaintRefused(fmt.Sprintf("%s is %s; it cannot become %s.", c.Number, strings.ToLower(ComplaintStatusLabel[c.Status]), strings.ToLower(label)))
}

// ValidateComplaintMove takes a complaint to in progress or closed along COMPLAINT_TRANSITIONS;
// resolving has its own command.
func ValidateComplaintMove(c Complaint, to string) error {
	if (to != "in_progress" && to != "closed") || !slices.Contains(ComplaintTransitions[c.Status], to) {
		return cannotBecome(c, to)
	}
	return nil
}

// Move applies an accepted move. Back to in progress from resolved clears the resolution and
// refuses a credit still waiting for approval.
func (c *Complaint) Move(to, note, by, at string) {
	from := c.Status
	c.Status = to
	if from == "resolved" && to == "in_progress" {
		c.Resolution = nil
		if c.Compensation != nil && c.Compensation.Status == "pending_approval" {
			c.Compensation.Status, c.Compensation.DecidedBy, c.Compensation.DecidedAt = "rejected", &by, &at
		}
	}
	text := fmt.Sprintf("%s to %s", ComplaintStatusLabel[from], strings.ToLower(ComplaintStatusLabel[to]))
	if n := strings.TrimSpace(note); n != "" {
		text += ": " + n
	}
	c.Timeline = append(c.Timeline, ComplaintEntry{At: at, By: by, Kind: "status", Note: text})
}

// ValidateNote checks a timeline note.
func ValidateNote(note string) error {
	if short(note, 2) {
		return errs.Invalid("note", "Write the note.")
	}
	return nil
}

// AddNote appends a note; a ref joins the links too.
func (c *Complaint) AddNote(note string, ref *Link, by, at string) {
	kind := "note"
	if ref != nil {
		kind = "link"
		c.Links = append(c.Links, *ref)
	}
	c.Timeline = append(c.Timeline, ComplaintEntry{At: at, By: by, Kind: kind, Note: strings.TrimSpace(note), Ref: ref})
}

// CompensationInput is what the resolver offers.
type CompensationInput struct {
	Kind        string `json:"kind"`
	Amount      int64  `json:"amount"`
	Description string `json:"description"`
}

// ResolveInput is the body of POST /complaints/{id}/resolve.
type ResolveInput struct {
	Action       string             `json:"action"`
	Compensation *CompensationInput `json:"compensation"`
}

// ValidateResolve checks the state, then the fields, then that a credit has a stay.
func ValidateResolve(c Complaint, in ResolveInput) error {
	if c.Status != "open" && c.Status != "in_progress" {
		return cannotBecome(c, "resolved")
	}
	var f errs.Fields
	if short(in.Action, 3) {
		f.Add("action", "Say what was done.")
	}
	if k := in.Compensation; k != nil {
		if _, ok := CompensationKindLabel[k.Kind]; !ok {
			f.Add("compensation.kind", "Pick the compensation.")
		}
		if k.Kind == "folio_credit" && k.Amount <= 0 {
			f.Add("compensation.amount", "Enter the credit in whole rupiah.")
		}
		if short(k.Description, 3) {
			f.Add("compensation.description", "Say what the guest gets.")
		}
	}
	if err := f.Err(); err != nil {
		return err
	}
	if in.Compensation != nil && in.Compensation.Kind == "folio_credit" && c.BookingID == nil {
		return errs.New("COMPENSATION_NO_STAY", "A folio credit needs the guest's stay; link the stay first.")
	}
	return nil
}

// Resolve records the resolution and the compensation. A credit posts at once when post is true,
// else it waits for approval. It answers whether the folio posting is to be requested.
func (c *Complaint) Resolve(in ResolveInput, post bool, by, at string) bool {
	c.Status = "resolved"
	c.Resolution = &Resolution{Action: strings.TrimSpace(in.Action), By: by, At: at}
	c.Timeline = append(c.Timeline, ComplaintEntry{At: at, By: by, Kind: "resolved", Note: c.Resolution.Action})
	k := in.Compensation
	if k == nil {
		return false
	}
	comp := Compensation{Kind: k.Kind, Description: strings.TrimSpace(k.Description), Status: "given"}
	note := fmt.Sprintf("%s: %s", CompensationKindLabel[k.Kind], comp.Description)
	if k.Kind == "folio_credit" {
		comp.Amount = k.Amount
		if post {
			comp.Status, comp.DecidedBy, comp.DecidedAt = "posted", &by, &at
			note = fmt.Sprintf("Credit of %d posted to the folio", k.Amount)
		} else {
			comp.Status = "pending_approval"
			note = fmt.Sprintf("Credit of %d waits for a manager's approval", k.Amount)
		}
	}
	c.Compensation = &comp
	c.Timeline = append(c.Timeline, ComplaintEntry{At: at, By: by, Kind: "compensation", Note: note})
	return comp.Status == "posted"
}

// CompensationDecision is the body of POST /complaints/{id}/compensation.
type CompensationDecision struct {
	Approve bool   `json:"approve"`
	Note    string `json:"note"`
}

// CheckPending refuses a decision when no credit waits.
func CheckPending(c Complaint) error {
	if c.Compensation == nil || c.Compensation.Status != "pending_approval" {
		return errs.Newf("COMPENSATION_INVALID_STATE", "There is no compensation waiting for approval on %s.", c.Number)
	}
	return nil
}

// ValidateDecision checks a credit waits and a refusal says why.
func ValidateDecision(c Complaint, d CompensationDecision) error {
	if err := CheckPending(c); err != nil {
		return err
	}
	if !d.Approve && short(d.Note, 3) {
		return errs.Invalid("note", "Say why the credit is refused.")
	}
	return nil
}

// Decide approves or refuses the waiting credit.
func (c *Complaint) Decide(d CompensationDecision, by, at string) {
	k := c.Compensation
	k.DecidedBy, k.DecidedAt = &by, &at
	note := fmt.Sprintf("Credit of %d approved and posted to the folio", k.Amount)
	k.Status = "posted"
	if !d.Approve {
		k.Status = "rejected"
		note = fmt.Sprintf("Credit of %d refused", k.Amount)
	}
	if n := strings.TrimSpace(d.Note); n != "" {
		note += ": " + n
	}
	c.Timeline = append(c.Timeline, ComplaintEntry{At: at, By: by, Kind: "compensation", Note: note})
}

// IncidentKindLabel names the incident kinds.
var IncidentKindLabel = map[string]string{
	"accident": "Accident or injury", "theft": "Theft or loss", "damage": "Damage to property", "security": "Security",
	"medical": "Medical", "fire": "Fire or safety", "other": "Other",
}

var personKinds = map[string]bool{"guest": true, "staff": true, "outsider": true}

// IncidentPerson is someone involved in an incident.
type IncidentPerson struct {
	Kind    string  `json:"kind"`
	Name    string  `json:"name"`
	GuestID *string `json:"guestId"`
	Note    string  `json:"note"`
}

// IncidentEntry is one line of an incident's timeline.
type IncidentEntry struct {
	At   string `json:"at"`
	By   string `json:"by"`
	Kind string `json:"kind"`
	Note string `json:"note"`
}

// IncidentCharge is the damage charged to the guest's folio.
type IncidentCharge struct {
	Amount    int64  `json:"amount"`
	Reason    string `json:"reason"`
	BookingID string `json:"bookingId"`
	By        string `json:"by"`
	At        string `json:"at"`
}

// SignOff is the manager's close.
type SignOff struct {
	By   string `json:"by"`
	At   string `json:"at"`
	Note string `json:"note"`
}

// Incident is something that happened at the property that is not a guest's complaint.
type Incident struct {
	ID           string            `json:"id"`
	Number       string            `json:"number"`
	Kind         string            `json:"kind"`
	Severity     string            `json:"severity"`
	VillaID      string            `json:"villaId"`
	UnitID       *string           `json:"unitId"`
	Area         string            `json:"area"`
	OccurredAt   string            `json:"occurredAt"`
	BookingID    *string           `json:"bookingId"`
	People       []IncidentPerson  `json:"people"`
	Description  string            `json:"description"`
	Actions      string            `json:"actions"`
	PoliceCalled bool              `json:"policeCalled"`
	DoctorCalled bool              `json:"doctorCalled"`
	PoliceReport string            `json:"policeReport"`
	Attachments  []json.RawMessage `json:"attachments"`
	ReportedBy   string            `json:"reportedBy"`
	Status       string            `json:"status"`
	Timeline     []IncidentEntry   `json:"timeline"`
	Charge       *IncidentCharge   `json:"charge"`
	SignOff      *SignOff          `json:"signOff"`
	Version      int64             `json:"-"`
}

// IncidentInput is IncidentInput.
type IncidentInput struct {
	Kind         string            `json:"kind"`
	Severity     string            `json:"severity"`
	VillaID      string            `json:"villaId"`
	UnitID       *string           `json:"unitId"`
	Area         string            `json:"area"`
	OccurredAt   string            `json:"occurredAt"`
	BookingID    *string           `json:"bookingId"`
	People       []IncidentPerson  `json:"people"`
	Description  string            `json:"description"`
	Actions      string            `json:"actions"`
	PoliceCalled bool              `json:"policeCalled"`
	DoctorCalled bool              `json:"doctorCalled"`
	PoliceReport string            `json:"policeReport"`
	Attachments  []json.RawMessage `json:"attachments"`
}

// ValidateIncident is validateIncident, in its field order.
func ValidateIncident(in IncidentInput, today string) error {
	var f errs.Fields
	if _, ok := IncidentKindLabel[in.Kind]; !ok {
		f.Add("kind", "Pick the kind of incident.")
	}
	if _, ok := SeverityLabel[in.Severity]; !ok {
		f.Add("severity", "Pick the severity.")
	}
	if in.VillaID == "" {
		f.Add("villaId", "Pick the villa.")
	}
	validMinute(&f, "occurredAt", in.OccurredAt, "Enter when it happened.", today)
	if !set(in.UnitID) && !set(in.BookingID) && short(in.Area, 2) {
		f.Add("area", "Say where it happened.")
	}
	if short(in.Description, 5) {
		f.Add("description", "Describe what happened.")
	}
	for i, p := range in.People {
		if short(p.Name, 2) {
			f.Add(fmt.Sprintf("people.%d.name", i), "Name the person.")
		}
		if !personKinds[p.Kind] {
			f.Add(fmt.Sprintf("people.%d.kind", i), "Pick who they are.")
		}
	}
	if len(in.Attachments) > MaxAttachments {
		f.Add("attachments", "Attach at most 10 files.")
	}
	return f.Err()
}

// Apply sets the cleaned input; the stay's villa and unit are already filled in.
func (i *Incident) Apply(in IncidentInput) {
	i.Kind, i.Severity, i.VillaID, i.UnitID = in.Kind, in.Severity, in.VillaID, emptyToNil(in.UnitID)
	i.Area, i.OccurredAt, i.BookingID = strings.TrimSpace(in.Area), in.OccurredAt, emptyToNil(in.BookingID)
	i.People = make([]IncidentPerson, 0, len(in.People))
	for _, p := range in.People {
		i.People = append(i.People, IncidentPerson{Kind: p.Kind, Name: strings.TrimSpace(p.Name), GuestID: emptyToNil(p.GuestID), Note: strings.TrimSpace(p.Note)})
	}
	i.Description, i.Actions, i.PoliceReport = strings.TrimSpace(in.Description), strings.TrimSpace(in.Actions), strings.TrimSpace(in.PoliceReport)
	i.PoliceCalled, i.DoctorCalled = in.PoliceCalled, in.DoctorCalled
	i.Attachments = append([]json.RawMessage{}, in.Attachments...)
}

// CheckIncidentOpen refuses a change to a closed incident.
func CheckIncidentOpen(i Incident) error {
	if i.Status == "closed" {
		return errs.New("INCIDENT_INVALID_STATE", i.Number+" is closed.")
	}
	return nil
}

// FollowUp appends a follow-up; an open incident moves to follow-up.
func (i *Incident) FollowUp(note, by, at string) {
	if i.Status == "open" {
		i.Status = "follow_up"
	}
	i.Timeline = append(i.Timeline, IncidentEntry{At: at, By: by, Kind: "follow_up", Note: strings.TrimSpace(note)})
}

// ChargeInput is the body of POST /incidents/{id}/charge.
type ChargeInput struct {
	Amount int64  `json:"amount"`
	Reason string `json:"reason"`
}

// ValidateCharge checks the incident may charge its stay; the stay's state is the command's.
func ValidateCharge(i Incident, in ChargeInput, bookingCode string) error {
	if err := CheckIncidentOpen(i); err != nil {
		return err
	}
	if i.Kind != "damage" {
		return errs.New("INCIDENT_CHARGE_KIND", "Only damage to property is charged to a guest.")
	}
	if i.BookingID == nil {
		return errs.New("INCIDENT_NO_STAY", "Link the guest's stay before charging the damage.")
	}
	if i.Charge != nil {
		return errs.Newf("INCIDENT_ALREADY_CHARGED", "%s is already charged to %s.", i.Number, bookingCode)
	}
	var f errs.Fields
	if in.Amount <= 0 {
		f.Add("amount", "Enter the charge in whole rupiah.")
	}
	if short(in.Reason, 3) {
		f.Add("reason", "Say what was damaged.")
	}
	return f.Err()
}

// SafeBoxSizeLabel names the box sizes.
var SafeBoxSizeLabel = map[string]string{"small": "Small", "medium": "Medium", "large": "Large"}

// SafeBoxStatusLabel names the box statuses.
var SafeBoxStatusLabel = map[string]string{"free": "Free", "in_use": "In use", "out_of_order": "Out of order"}

// SafeBox is a safe deposit box of a property.
type SafeBox struct {
	ID      string `json:"id"`
	VillaID string `json:"villaId"`
	Number  string `json:"number"`
	Size    string `json:"size"`
	Status  string `json:"status"`
	Note    string `json:"note"`
	Version int64  `json:"-"`
}

// SafeBoxInput is SafeBoxInput.
type SafeBoxInput struct {
	VillaID    string `json:"villaId"`
	Number     string `json:"number"`
	Size       string `json:"size"`
	Note       string `json:"note"`
	OutOfOrder bool   `json:"outOfOrder"`
}

// ValidateSafeBox checks the fields; others are the boxes of the villa besides this one.
func ValidateSafeBox(in SafeBoxInput, others []SafeBox, villaName string) error {
	var f errs.Fields
	number := strings.TrimSpace(in.Number)
	switch {
	case number == "" || len([]rune(number)) > 8:
		f.Add("number", "Number the box.")
	case slices.ContainsFunc(others, func(b SafeBox) bool { return strings.EqualFold(b.Number, number) }):
		f.Add("number", fmt.Sprintf("Box %s is already at %s.", number, villaName))
	}
	if _, ok := SafeBoxSizeLabel[in.Size]; !ok {
		f.Add("size", "Pick the size.")
	}
	return f.Err()
}

// Apply sets the input; a box in use stays in use.
func (b *SafeBox) Apply(in SafeBoxInput) error {
	if in.OutOfOrder && b.Status == "in_use" {
		return errs.Newf("SAFE_BOX_IN_USE", "Box %s is in use; close it first.", b.Number)
	}
	b.Number, b.Size, b.Note = strings.TrimSpace(in.Number), in.Size, strings.TrimSpace(in.Note)
	switch {
	case in.OutOfOrder:
		b.Status = "out_of_order"
	case b.Status != "in_use":
		b.Status = "free"
	}
	return nil
}

// BoxEntry is one access to a box.
type BoxEntry struct {
	Kind          string `json:"kind"`
	At            string `json:"at"`
	By            string `json:"by"`
	Signature     string `json:"signature"`
	SignatureData string `json:"signatureData"`
	Note          string `json:"note"`
}

// BoxRental is a box opened for a stay.
type BoxRental struct {
	ID          string     `json:"id"`
	Number      string     `json:"number"`
	BoxID       string     `json:"boxId"`
	VillaID     string     `json:"villaId"`
	BookingID   string     `json:"bookingId"`
	GuestID     string     `json:"guestId"`
	Items       string     `json:"items"`
	KeyNumber   string     `json:"keyNumber"`
	Status      string     `json:"status"`
	OpenedAt    string     `json:"openedAt"`
	OpenedBy    string     `json:"openedBy"`
	ClosedAt    *string    `json:"closedAt"`
	ClosedBy    *string    `json:"closedBy"`
	KeyReturned *bool      `json:"keyReturned"`
	KeyFee      int64      `json:"keyFee"`
	Log         []BoxEntry `json:"log"`
	Version     int64      `json:"-"`
}

// Signed is the guest's mark on an access.
type Signed struct {
	Signature     string `json:"signature"`
	SignatureData string `json:"signatureData"`
}

func (s Signed) check(f *errs.Fields) {
	ok := s.Signature == "paper" || (s.Signature == "drawn" && s.SignatureData != "" && len(s.SignatureData) <= MaxSignatureData)
	if !ok {
		f.Add("signature", "Have the guest sign, or mark it signed on paper.")
	}
}

func (s Signed) data() string {
	if s.Signature == "drawn" {
		return s.SignatureData
	}
	return ""
}

// OpenBoxInput is the body of POST /safe-box-rentals.
type OpenBoxInput struct {
	BoxID     string `json:"boxId"`
	BookingID string `json:"bookingId"`
	Items     string `json:"items"`
	KeyNumber string `json:"keyNumber"`
	Signed
}

// ValidateOpenBox checks the box, the stay and the fields, in the contract's order.
func ValidateOpenBox(box SafeBox, stay Stay, in OpenBoxInput) error {
	if box.Status != "free" {
		return errs.Newf("SAFE_BOX_UNAVAILABLE", "Box %s is %s.", box.Number, strings.ToLower(SafeBoxStatusLabel[box.Status]))
	}
	if stay.Status != "checked_in" {
		return errs.Newf("BOOKING_INVALID_STATE", "%s is not in house; open a box during the stay.", stay.Code)
	}
	var f errs.Fields
	if stay.VillaID != box.VillaID {
		f.Add("bookingId", stay.Code+" stays at another villa.")
	}
	if strings.TrimSpace(in.KeyNumber) == "" {
		f.Add("keyNumber", "Enter the key handed to the guest.")
	}
	in.check(&f)
	return f.Err()
}

// CheckBoxOpen refuses an access to a closed rental.
func CheckBoxOpen(r BoxRental) error {
	if r.Status != "open" {
		return errs.New("SAFE_BOX_CLOSED", r.Number+" is closed.")
	}
	return nil
}

// BoxAccessInput is the body of POST /safe-box-rentals/{id}/access.
type BoxAccessInput struct {
	Kind string `json:"kind"`
	Note string `json:"note"`
	Signed
}

// ValidateBoxAccess checks an add or take.
func ValidateBoxAccess(r BoxRental, in BoxAccessInput) error {
	if err := CheckBoxOpen(r); err != nil {
		return err
	}
	var f errs.Fields
	if in.Kind != "add" && in.Kind != "take" {
		f.Add("kind", "Pick what the guest did.")
	}
	in.check(&f)
	return f.Err()
}

// Access logs the add or take.
func (r *BoxRental) Access(in BoxAccessInput, by, at string) {
	r.Log = append(r.Log, BoxEntry{Kind: in.Kind, At: at, By: by, Signature: in.Signature, SignatureData: in.data(), Note: strings.TrimSpace(in.Note)})
}

// CloseBoxInput is the body of POST /safe-box-rentals/{id}/close.
type CloseBoxInput struct {
	KeyReturned bool   `json:"keyReturned"`
	KeyFee      int64  `json:"keyFee"`
	Note        string `json:"note"`
	Signed
}

// ValidateCloseBox checks the close; the stay's state for a fee is the command's.
func ValidateCloseBox(r BoxRental, in CloseBoxInput) error {
	if err := CheckBoxOpen(r); err != nil {
		return err
	}
	var f errs.Fields
	switch {
	case in.KeyFee < 0:
		f.Add("keyFee", "Enter the key fee in whole rupiah, or zero.")
	case in.KeyFee > 0 && in.KeyReturned:
		f.Add("keyFee", "Charge a fee only for a lost key.")
	}
	in.check(&f)
	return f.Err()
}

// Close returns the key, or logs it lost, and closes the rental.
func (r *BoxRental) Close(in CloseBoxInput, by, at string) {
	if !in.KeyReturned {
		r.Log = append(r.Log, BoxEntry{Kind: "key_lost", At: at, By: by, Signature: "none", Note: ""})
	}
	r.Log = append(r.Log, BoxEntry{Kind: "close", At: at, By: by, Signature: in.Signature, SignatureData: in.data(), Note: strings.TrimSpace(in.Note)})
	returned := in.KeyReturned
	r.Status, r.ClosedAt, r.ClosedBy, r.KeyReturned, r.KeyFee = "closed", &at, &by, &returned, in.KeyFee
}
