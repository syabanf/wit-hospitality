package domain

import (
	"strings"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func refused(t *testing.T, err error, code, message string) {
	t.Helper()
	e, ok := errs.As(err)
	if !ok || e.Code != code || e.Message != message {
		t.Fatalf("want %s %q, got %v", code, message, err)
	}
}

func fieldErrors(t *testing.T, err error) map[string]string {
	t.Helper()
	e, ok := errs.As(err)
	if !ok || e.Code != errs.CodeValidation {
		t.Fatalf("want field errors, got %v", err)
	}
	return errs.Fields(e.Fields).Map()
}

func str(s string) *string { return &s }

const today = "2026-11-11"

func TestValidateComplaint(t *testing.T) {
	f := fieldErrors(t, ValidateComplaint(ComplaintInput{}, today))
	want := map[string]string{
		"villaId": "Pick the villa.", "guestId": "Pick the guest or the stay.", "category": "Pick the category.", "severity": "Pick the severity.",
		"description": "Write what the guest said.", "receivedBy": "Say who received it.", "receivedAt": "Enter when it was received.", "owner": "Name who follows it up.",
	}
	for k, v := range want {
		if f[k] != v {
			t.Fatalf("%s: want %q, got %q", k, v, f[k])
		}
	}
	ok := ComplaintInput{VillaID: "vil-saka", GuestID: str("g-01"), Category: "noise", Severity: "high", Description: "Music past midnight",
		ReceivedBy: "Wayan", ReceivedAt: "2026-11-11T08:30", Owner: "Kadek"}
	if err := ValidateComplaint(ok, today); err != nil {
		t.Fatal(err)
	}
	ok.ReceivedAt = "2026-11-12T08:30"
	if f := fieldErrors(t, ValidateComplaint(ok, today)); f["receivedAt"] != "The time cannot be in the future." {
		t.Fatal(f)
	}
}

func complaint(status string) Complaint {
	return Complaint{Number: "CP-004", Status: status, BookingID: str("bk-1"), Timeline: []ComplaintEntry{}}
}

func TestComplaintMoves(t *testing.T) {
	refused(t, ValidateComplaintMove(complaint("open"), "closed"), "COMPLAINT_INVALID_STATE", "CP-004 is open; it cannot become closed.")
	refused(t, ValidateComplaintMove(complaint("open"), "resolved"), "COMPLAINT_INVALID_STATE", "CP-004 is open; it cannot become resolved.")
	refused(t, ValidateComplaintMove(complaint("closed"), "in_progress"), "COMPLAINT_INVALID_STATE", "CP-004 is closed; it cannot become in progress.")
	if err := ValidateComplaintMove(complaint("resolved"), "closed"); err != nil {
		t.Fatal(err)
	}
	// Reopening clears the resolution and refuses a credit still waiting.
	c := complaint("open")
	c.Resolve(ResolveInput{Action: "Moved the guest", Compensation: &CompensationInput{Kind: "folio_credit", Amount: 900_000, Description: "Night refund"}}, false, "Wayan", "2026-11-11T09:00:00")
	if c.Compensation.Status != "pending_approval" {
		t.Fatal(c.Compensation)
	}
	c.Move("in_progress", "", "Kadek", "2026-11-11T10:00:00")
	if c.Resolution != nil || c.Compensation.Status != "rejected" || *c.Compensation.DecidedBy != "Kadek" {
		t.Fatalf("reopen %+v", c)
	}
}

func TestResolve(t *testing.T) {
	refused(t, ValidateResolve(complaint("resolved"), ResolveInput{Action: "x"}), "COMPLAINT_INVALID_STATE", "CP-004 is resolved; it cannot become resolved.")
	f := fieldErrors(t, ValidateResolve(complaint("open"), ResolveInput{Compensation: &CompensationInput{Kind: "folio_credit"}}))
	if f["action"] != "Say what was done." || f["compensation.amount"] != "Enter the credit in whole rupiah." || f["compensation.description"] != "Say what the guest gets." {
		t.Fatal(f)
	}
	if f := fieldErrors(t, ValidateResolve(complaint("open"), ResolveInput{Action: "Done", Compensation: &CompensationInput{Kind: "cash", Description: "x y z"}})); f["compensation.kind"] != "Pick the compensation." {
		t.Fatal(f)
	}
	noStay := complaint("open")
	noStay.BookingID = nil
	refused(t, ValidateResolve(noStay, ResolveInput{Action: "Done", Compensation: &CompensationInput{Kind: "folio_credit", Amount: 1, Description: "Credit"}}),
		"COMPENSATION_NO_STAY", "A folio credit needs the guest's stay; link the stay first.")

	c := complaint("in_progress")
	if c.Resolve(ResolveInput{Action: "Flowers", Compensation: &CompensationInput{Kind: "goodwill", Description: "Flowers and a note"}}, false, "Wayan", "t") {
		t.Fatal("a goodwill gesture posts nothing")
	}
	if c.Compensation.Status != "given" || c.Compensation.Amount != 0 || c.Status != "resolved" {
		t.Fatal(c.Compensation)
	}
	refused(t, CheckPending(c), "COMPENSATION_INVALID_STATE", "There is no compensation waiting for approval on CP-004.")
}

func TestValidateIncident(t *testing.T) {
	in := IncidentInput{People: []IncidentPerson{{Kind: "alien", Name: "x"}}, OccurredAt: "2026-11-11T07:00"}
	f := fieldErrors(t, ValidateIncident(in, today))
	want := map[string]string{"kind": "Pick the kind of incident.", "severity": "Pick the severity.", "villaId": "Pick the villa.", "area": "Say where it happened.",
		"description": "Describe what happened.", "people.0.name": "Name the person.", "people.0.kind": "Pick who they are."}
	for k, v := range want {
		if f[k] != v {
			t.Fatalf("%s: want %q, got %q", k, v, f[k])
		}
	}
	if _, ok := f["occurredAt"]; ok {
		t.Fatal("a valid time")
	}
	i := Incident{Number: "IN-002", Kind: "medical", Status: "open"}
	refused(t, ValidateCharge(i, ChargeInput{Amount: 1, Reason: "lamp"}, ""), "INCIDENT_CHARGE_KIND", "Only damage to property is charged to a guest.")
	i.Kind = "damage"
	refused(t, ValidateCharge(i, ChargeInput{Amount: 1, Reason: "lamp"}, ""), "INCIDENT_NO_STAY", "Link the guest's stay before charging the damage.")
	i.BookingID, i.Charge = str("bk-1"), &IncidentCharge{}
	refused(t, ValidateCharge(i, ChargeInput{Amount: 1, Reason: "lamp"}, "BK-1"), "INCIDENT_ALREADY_CHARGED", "IN-002 is already charged to BK-1.")
	i.Status = "closed"
	refused(t, ValidateCharge(i, ChargeInput{}, ""), "INCIDENT_INVALID_STATE", "IN-002 is closed.")
}

func TestSafeBoxes(t *testing.T) {
	others := []SafeBox{{Number: "A1"}}
	if f := fieldErrors(t, ValidateSafeBox(SafeBoxInput{Number: "a1", Size: "huge"}, others, "Villa Saka")); f["number"] != "Box a1 is already at Villa Saka." || f["size"] != "Pick the size." {
		t.Fatal(f)
	}
	if f := fieldErrors(t, ValidateSafeBox(SafeBoxInput{Number: "123456789", Size: "small"}, nil, "")); f["number"] != "Number the box." {
		t.Fatal(f)
	}
	box := SafeBox{Number: "3", Status: "in_use", VillaID: "vil-saka"}
	refused(t, box.Apply(SafeBoxInput{Number: "3", Size: "small", OutOfOrder: true}), "SAFE_BOX_IN_USE", "Box 3 is in use; close it first.")

	stay := Stay{Code: "BK-1", Status: "checked_in", VillaID: "vil-saka"}
	refused(t, ValidateOpenBox(box, stay, OpenBoxInput{}), "SAFE_BOX_UNAVAILABLE", "Box 3 is in use.")
	box.Status = "free"
	refused(t, ValidateOpenBox(box, Stay{Code: "BK-1", Status: "confirmed"}, OpenBoxInput{}), "BOOKING_INVALID_STATE", "BK-1 is not in house; open a box during the stay.")
	f := fieldErrors(t, ValidateOpenBox(box, Stay{Code: "BK-1", Status: "checked_in", VillaID: "vil-tirta"}, OpenBoxInput{Signed: Signed{Signature: "drawn"}}))
	if f["bookingId"] != "BK-1 stays at another villa." || f["keyNumber"] != "Enter the key handed to the guest." || f["signature"] != "Have the guest sign, or mark it signed on paper." {
		t.Fatal(f)
	}
	if err := ValidateOpenBox(box, stay, OpenBoxInput{KeyNumber: "K3", Signed: Signed{Signature: "paper"}}); err != nil {
		t.Fatal(err)
	}

	r := BoxRental{Number: "SB-004", Status: "open", Log: []BoxEntry{}}
	if f := fieldErrors(t, ValidateCloseBox(r, CloseBoxInput{KeyReturned: true, KeyFee: 50_000, Signed: Signed{Signature: "paper"}})); f["keyFee"] != "Charge a fee only for a lost key." {
		t.Fatal(f)
	}
	if f := fieldErrors(t, ValidateBoxAccess(r, BoxAccessInput{Kind: "peek", Signed: Signed{Signature: "paper"}})); f["kind"] != "Pick what the guest did." {
		t.Fatal(f)
	}
	r.Close(CloseBoxInput{KeyFee: 150_000, Signed: Signed{Signature: "drawn", SignatureData: "data:image/png;base64,AA"}}, "Wayan", "t")
	if r.Status != "closed" || *r.KeyReturned || len(r.Log) != 2 || r.Log[0].Kind != "key_lost" || !strings.HasPrefix(r.Log[1].SignatureData, "data:") {
		t.Fatalf("closed %+v", r)
	}
	refused(t, ValidateBoxAccess(r, BoxAccessInput{}), "SAFE_BOX_CLOSED", "SB-004 is closed.")
}
