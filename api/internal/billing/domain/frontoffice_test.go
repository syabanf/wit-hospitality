package domain

import (
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func message(err error) string {
	if e, ok := errs.As(err); ok {
		return e.Message
	}
	return ""
}

func TestACardHoldKeepsTheBrandAndLastFourAndStandsUpTo30Days(t *testing.T) {
	ok := PreAuthInput{BookingID: "b1", Amount: 2_000_000, Brand: "visa", Last4: "4242", ExpiresOn: "2026-11-15"}
	if err := ValidatePreAuth(ok, "2026-11-11"); err != nil {
		t.Fatal(err)
	}
	bad := PreAuthInput{Amount: 1.5, Brand: "diners", Last4: "424", ApprovalCode: "A1", ExpiresOn: "2026-11-10"}
	field(t, ValidatePreAuth(bad, "2026-11-11"), "amount", "brand", "last4", "approvalCode", "expiresOn")
	far := ok
	far.ExpiresOn = "2026-12-12"
	eq(t, message(ValidatePreAuth(far, "2026-11-11")), "A card hold stands at most 30 days.")
	eq(t, GatewayApprovalCode(1), "A07919")
	eq(t, GatewayApprovalCode(13), "A02947")
}

func TestOneActiveHoldPerStayArrivingOrInHouse(t *testing.T) {
	b := Booking{ID: "b1", Code: "BK-1001", Status: "checked_out"}
	err := HoldProblem(b, nil)
	code(t, err, "PREAUTH_STAY")
	eq(t, message(err), "BK-1001 is checked out; a card hold is for a stay arriving or in house.")
	b.Status = CheckedIn
	err = HoldProblem(b, []PreAuth{{BookingID: "b1", Number: "PA-1002", Status: HoldActive}})
	eq(t, message(err), "BK-1001 already holds PA-1002; capture or release it first.")
	if err := HoldProblem(b, []PreAuth{{BookingID: "b1", Status: HoldReleased}}); err != nil {
		t.Fatal(err)
	}
}

func TestACaptureStaysInsideTheHoldAndTheRoomBalance(t *testing.T) {
	h := PreAuth{Number: "PA-1002", Amount: 2_000_000, Status: HoldActive, ExpiresOn: "2026-11-13"}
	eq(t, message(h.CaptureProblem(2_500_000, 3_000_000, "2026-11-11")), "Only 2.000.000 is held.")
	eq(t, message(h.CaptureProblem(1_500_000, 1_000_000, "2026-11-11")), "The room balance is 1.000.000; capture at most that.")
	field(t, h.CaptureProblem(0, 1_000_000, "2026-11-11"), "amount")
	if err := h.CaptureProblem(1_000_000, 1_000_000, "2026-11-11"); err != nil {
		t.Fatal(err)
	}
	err := h.CaptureProblem(1_000_000, 1_000_000, "2026-11-14")
	code(t, err, "PREAUTH_EXPIRED")
	eq(t, message(err), "The hold on PA-1002 lapsed on 2026-11-13; take the money another way.")
	eq(t, h.Expired("2026-11-14"), true)
	h.Status = HoldReleased
	eq(t, message(h.CaptureProblem(1, 1, "2026-11-11")), "PA-1002 is released.")
}

func TestTheShiftOfAStampPutsTheSmallHoursOnTheDayBefore(t *testing.T) {
	for stamp, want := range map[string][2]string{
		"2026-11-11T07:00:00": {"morning", "2026-11-11"},
		"2026-11-11T14:59:00": {"morning", "2026-11-11"},
		"2026-11-11T15:00:00": {"afternoon", "2026-11-11"},
		"2026-11-11T23:10:00": {"night", "2026-11-11"},
		"2026-11-11T02:30:00": {"night", "2026-11-10"},
	} {
		shift, date := ShiftOf(stamp)
		eq(t, [2]string{shift, date}, want)
	}
}

func TestALogEntryNeedsACategoryAndText(t *testing.T) {
	f := ValidateLog(LogInput{Category: "gossip", Text: " a ", Link: &LogLink{Kind: "car"}})
	field(t, f.Err(), "category", "text", "link")
	long := make([]byte, 1001)
	for i := range long {
		long[i] = 'x'
	}
	eq(t, LogTextProblem(string(long)), "Keep an entry under 1000 characters.")
}

func TestTheNextShiftAcknowledgesAFollowUpAndAnyoneClosesIt(t *testing.T) {
	e := LogEntry{AuthorID: "usr-dian", FollowUp: true}
	code(t, e.AcknowledgeProblem("usr-dian"), "LOG_OWN_ENTRY")
	if err := e.AcknowledgeProblem("usr-kadek"); err != nil {
		t.Fatal(err)
	}
	name, at := "Kadek Ariani", "2026-11-11T08:05:00"
	e.AcknowledgedBy, e.AcknowledgedAt = &name, &at
	eq(t, message(e.AcknowledgeProblem("usr-wayan")), "Kadek Ariani acknowledged it at 08:05.")
	if err := e.DoneProblem("Fixed"); err != nil {
		t.Fatal(err)
	}
	e.DoneBy, e.DoneAt = &name, &at
	eq(t, message(e.DoneProblem("")), "Kadek Ariani marked it done at 08:05.")
	code(t, LogEntry{}.DoneProblem(""), "LOG_NO_FOLLOW_UP")
}

func TestOpenDiscrepanciesBlockTheAuditUnlessAManagerGivesAReason(t *testing.T) {
	if o, err := DiscrepancyBlock(0, &AuditOverride{Reason: "x"}, true, "Rama"); o != nil || err != nil {
		t.Fatal("no open discrepancy keeps no override")
	}
	_, err := DiscrepancyBlock(1, nil, true, "Rama")
	eq(t, message(err), "1 room discrepancy is still open; resolve it before closing the day.")
	_, err = DiscrepancyBlock(2, nil, true, "Rama")
	eq(t, message(err), "2 room discrepancies are still open; resolve them before closing the day.")
	_, err = DiscrepancyBlock(2, &AuditOverride{Reason: " ok "}, true, "Rama")
	eq(t, message(err), "Give the reason to close the day over open discrepancies.")
	_, err = DiscrepancyBlock(2, &AuditOverride{Reason: "Guest confirmed by phone"}, false, "Dian")
	code(t, err, "AUDIT_DISCREPANCIES")
	o, err := DiscrepancyBlock(2, &AuditOverride{By: "someone", Reason: " Guest confirmed by phone "}, true, "Rama")
	if err != nil {
		t.Fatal(err)
	}
	eq(t, *o, AuditOverride{By: "Rama", Reason: "Guest confirmed by phone"})
}
