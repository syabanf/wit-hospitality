package command_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/guest/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// postings reads the folio postings guest asked billing for, by source.
func (e env) postings(t *testing.T, source string) []guest.FolioPostingRequested {
	t.Helper()
	rows, err := e.db.Pool.Query(context.Background(), `SELECT payload FROM platform.outbox WHERE event_type = $1 AND aggregate_id = $2 ORDER BY id`, guest.EventFolioPostingRequested, source)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []guest.FolioPostingRequested
	for rows.Next() {
		var raw []byte
		var p guest.FolioPostingRequested
		if err := rows.Scan(&raw); err != nil || json.Unmarshal(raw, &p) != nil {
			t.Fatal(err)
		}
		out = append(out, p)
	}
	return out
}

func must[T any](t *testing.T) func(T, error) T {
	return func(v T, err error) T {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
}

func TestComplaintLifecycle(t *testing.T) {
	e := setup(t)
	stayID := e.stayWhere(t, "checked_in", "vil-saka")
	in := domain.ComplaintInput{VillaID: "vil-tirta", BookingID: &stayID, Category: "noise", Severity: "high", Description: "Music from the next room past midnight",
		ReceivedBy: "Wayan", ReceivedAt: "2026-11-11T08:30", Owner: "Wayan"}
	logc := command.LogComplaint{Deps: e.deps}

	if _, err := logc.Handle(context.Background(), hendra, in); !errs.HasCode(err, errs.CodeForbidden) {
		t.Fatalf("an investor logs no complaint: %v", err)
	}
	c := must[domain.Complaint](t)(logc.Handle(context.Background(), wayan, in))
	if c.Number != "CP-001" || c.VillaID != "vil-saka" || c.GuestID == "" || c.UnitID == nil || c.Status != "open" || c.Source != "desk" {
		t.Fatalf("the stay wins the villa, unit and guest: %+v", c)
	}
	other := "g-nobody"
	wrong := in
	wrong.GuestID = &other
	_, err := logc.Handle(context.Background(), wayan, wrong)
	refusal(t, err, errs.CodeValidation, "")

	note := command.NoteComplaint{Deps: e.deps}
	c = must[domain.Complaint](t)(note.Handle(context.Background(), wayan, c.ID, command.NoteBody{Note: "Raised a work order", Ref: &domain.Link{Kind: "work_order", ID: "wo-1", Label: "WO-519"}}))
	if len(c.Links) != 1 || c.Timeline[len(c.Timeline)-1].Kind != "link" {
		t.Fatalf("the ref joins the links: %+v", c)
	}
	move := command.MoveComplaint{Deps: e.deps}
	_, err = move.Handle(context.Background(), wayan, c.ID, command.MoveBody{To: "closed"})
	refusal(t, err, "COMPLAINT_INVALID_STATE", "CP-001 is open; it cannot become closed.")
	c = must[domain.Complaint](t)(move.Handle(context.Background(), wayan, c.ID, command.MoveBody{To: "in_progress", Note: "Spoke to the neighbours"}))
	e.audited(t, "CP-001 open to in progress")

	// Staff credit above the limit waits; the manager approves it and the posting is requested once.
	resolve := command.ResolveComplaint{Deps: e.deps}
	big := domain.ResolveInput{Action: "Moved the guest to a quiet room", Compensation: &domain.CompensationInput{Kind: "folio_credit", Amount: 800_000, Description: "One night off"}}
	c = must[domain.Complaint](t)(resolve.Handle(context.Background(), wayan, c.ID, big))
	if c.Status != "resolved" || c.Compensation.Status != "pending_approval" || len(e.postings(t, "complaint:"+c.ID)) != 0 {
		t.Fatalf("a large credit by staff waits: %+v", c.Compensation)
	}
	decide := command.DecideCompensation{Deps: e.deps}
	_, err = decide.Handle(context.Background(), wayan, c.ID, domain.CompensationDecision{Approve: true})
	refusal(t, err, errs.CodeForbidden, "Only someone who may approve in the guest module can approve compensation.")
	c = must[domain.Complaint](t)(decide.Handle(context.Background(), kadek, c.ID, domain.CompensationDecision{Approve: true}))
	posted := e.postings(t, "complaint:"+c.ID)
	if c.Compensation.Status != "posted" || len(posted) != 1 || posted[0].Kind != "credit" || posted[0].Amount != 800_000 || posted[0].BookingID != stayID ||
		posted[0].Description != "Compensation for CP-001: One night off" || posted[0].By != kadek.Name {
		t.Fatalf("approved credit %+v %+v", c.Compensation, posted)
	}
	e.audited(t, "Approved the credit of 800000 on CP-001")
	_, err = decide.Handle(context.Background(), kadek, c.ID, domain.CompensationDecision{Approve: true})
	refusal(t, err, "COMPENSATION_INVALID_STATE", "There is no compensation waiting for approval on CP-001.")

	c = must[domain.Complaint](t)(move.Handle(context.Background(), wayan, c.ID, command.MoveBody{To: "closed"}))
	_, err = note.Handle(context.Background(), wayan, c.ID, command.NoteBody{Note: "Late note"})
	refusal(t, err, "COMPLAINT_INVALID_STATE", "CP-001 is closed.")

	// A small credit posts at once; a credit on a stay that is not in house is refused.
	second := must[domain.Complaint](t)(logc.Handle(context.Background(), wayan, in))
	small := domain.ResolveInput{Action: "Apologised", Compensation: &domain.CompensationInput{Kind: "folio_credit", Amount: 200_000, Description: "Dinner"}}
	second = must[domain.Complaint](t)(resolve.Handle(context.Background(), wayan, second.ID, small))
	if second.Compensation.Status != "posted" || len(e.postings(t, "complaint:"+second.ID)) != 1 {
		t.Fatalf("a small credit posts: %+v", second.Compensation)
	}
	gone := e.stayWhere(t, "checked_out", "vil-saka")
	left := in
	left.BookingID = &gone
	third := must[domain.Complaint](t)(logc.Handle(context.Background(), wayan, left))
	_, err = resolve.Handle(context.Background(), wayan, third.ID, small)
	refusal(t, err, "BOOKING_INVALID_STATE", "")

	list := must[[]domain.Complaint](t)(e.queries.Complaints(as(putu)))
	if len(list) != 0 {
		t.Fatalf("Putu works in Ubud: %d", len(list))
	}
}

func TestStayPageComplaint(t *testing.T) {
	e := setup(t)
	stayID := e.stayWhere(t, "checked_in", "vil-saka")
	logc := command.LogComplaint{Deps: e.deps}
	_, err := logc.FileFromStay(context.Background(), guest.StayComplaint{BookingID: stayID, Category: "loud", Description: "no"})
	if f := fieldsOf(t, err); f["category"] != "Pick what it is about." || f["description"] != "Tell us what went wrong." {
		t.Fatal(f)
	}
	filed := must[guest.Filed](t)(logc.FileFromStay(context.Background(), guest.StayComplaint{BookingID: stayID, Category: "cleanliness", Description: "Sand in the bed"}))
	list := must[[]domain.Complaint](t)(e.queries.Complaints(as(rama)))
	c := list[len(list)-1]
	if filed.Number != c.Number || c.Source != "stay_page" || c.Status != "open" || c.Severity != "medium" || c.ReceivedBy != "Guest" || c.Owner != "Front desk" {
		t.Fatalf("stay page complaint %+v", c)
	}
}

func fieldsOf(t *testing.T, err error) map[string]string {
	t.Helper()
	ex, ok := errs.As(err)
	if !ok {
		t.Fatalf("want field errors, got %v", err)
	}
	return errs.Fields(ex.Fields).Map()
}

func TestIncidentsAndBoxes(t *testing.T) {
	e := setup(t)
	stayID := e.stayWhere(t, "checked_in", "vil-saka")
	logi := command.LogIncident{Deps: e.deps}
	in := domain.IncidentInput{Kind: "damage", Severity: "high", VillaID: "vil-saka", BookingID: &stayID, OccurredAt: "2026-11-11T07:00",
		Description: "Glass table broken", People: []domain.IncidentPerson{{Kind: "guest", Name: "The guest"}}}
	i := must[domain.Incident](t)(logi.Handle(context.Background(), wayan, in))
	if i.Number != "IN-001" || i.Status != "open" || i.UnitID == nil {
		t.Fatalf("incident %+v", i)
	}
	charge := command.ChargeIncident{Deps: e.deps}
	i = must[domain.Incident](t)(charge.Handle(context.Background(), wayan, i.ID, domain.ChargeInput{Amount: 1_200_000, Reason: "Glass table top"}))
	posted := e.postings(t, "incident:"+i.ID)
	if i.Charge == nil || len(posted) != 1 || posted[0].Kind != "charge" || posted[0].Description != "Damage, IN-001: Glass table top" {
		t.Fatalf("charge %+v %+v", i.Charge, posted)
	}
	_, err := charge.Handle(context.Background(), wayan, i.ID, domain.ChargeInput{Amount: 1, Reason: "again"})
	refusal(t, err, "INCIDENT_ALREADY_CHARGED", "")
	i = must[domain.Incident](t)(command.FollowUpIncident{Deps: e.deps}.Handle(context.Background(), wayan, i.ID, command.NoteBodyText{Note: "Supplier quoted"}))
	if i.Status != "follow_up" {
		t.Fatal(i.Status)
	}
	closer := command.CloseIncident{Deps: e.deps}
	_, err = closer.Handle(context.Background(), wayan, i.ID, command.NoteBodyText{Note: "Done"})
	refusal(t, err, errs.CodeForbidden, "Only someone who may approve in the guest module can sign off an incident.")
	i = must[domain.Incident](t)(closer.Handle(context.Background(), kadek, i.ID, command.NoteBodyText{Note: "Paid and replaced"}))
	if i.Status != "closed" || i.SignOff == nil || i.SignOff.By != kadek.Name {
		t.Fatalf("closed %+v", i)
	}
	e.audited(t, "Signed off IN-001")

	add := command.AddSafeBox{Deps: e.deps}
	box := must[domain.SafeBox](t)(add.Handle(context.Background(), wayan, domain.SafeBoxInput{VillaID: "vil-saka", Number: "1", Size: "small"}))
	_, err = add.Handle(context.Background(), wayan, domain.SafeBoxInput{VillaID: "vil-saka", Number: "1", Size: "small"})
	if f := fieldsOf(t, err); f["number"] != "Box 1 is already at Villa Saka." {
		t.Fatal(f)
	}
	open := command.OpenBox{Deps: e.deps}
	r := must[domain.BoxRental](t)(open.Handle(context.Background(), wayan, domain.OpenBoxInput{BoxID: box.ID, BookingID: stayID, KeyNumber: "K1", Signed: domain.Signed{Signature: "paper"}}))
	if r.Number != "SB-001" || r.Status != "open" || r.Log[0].Kind != "open" {
		t.Fatalf("rental %+v", r)
	}
	_, err = open.Handle(context.Background(), wayan, domain.OpenBoxInput{BoxID: box.ID, BookingID: stayID, KeyNumber: "K1", Signed: domain.Signed{Signature: "paper"}})
	refusal(t, err, "SAFE_BOX_UNAVAILABLE", "Box 1 is in use.")
	_, err = command.UpdateSafeBox{Deps: e.deps}.Handle(context.Background(), wayan, box.ID, domain.SafeBoxInput{Number: "1", Size: "small", OutOfOrder: true})
	refusal(t, err, "SAFE_BOX_IN_USE", "Box 1 is in use; close it first.")
	r = must[domain.BoxRental](t)(command.AccessBox{Deps: e.deps}.Handle(context.Background(), wayan, r.ID, domain.BoxAccessInput{Kind: "take", Signed: domain.Signed{Signature: "paper"}}))
	r = must[domain.BoxRental](t)(command.CloseBox{Deps: e.deps}.Handle(context.Background(), wayan, r.ID, domain.CloseBoxInput{KeyFee: 250_000, Signed: domain.Signed{Signature: "paper"}}))
	fee := e.postings(t, "box-rental:"+r.ID)
	if r.Status != "closed" || r.KeyFee != 250_000 || len(fee) != 1 || fee[0].Description != "Lost safe box key, box 1 (SB-001)" {
		t.Fatalf("closed rental %+v %+v", r, fee)
	}
	boxes := must[[]domain.SafeBox](t)(e.queries.SafeBoxes(as(wayan)))
	if len(boxes) != 1 || boxes[0].Status != "free" {
		t.Fatalf("box back to free: %+v", boxes)
	}
}

// A merge moves the dropped guest's complaints and their place among an incident's people.
func TestMergeMovesRelations(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	drop := "g-26"
	c := must[domain.Complaint](t)(command.LogComplaint{Deps: e.deps}.Handle(ctx, kadek, domain.ComplaintInput{VillaID: "vil-saka", GuestID: &drop, Category: "food",
		Severity: "low", Description: "Cold breakfast", ReceivedBy: "Kadek", ReceivedAt: "2026-11-11T08:00", Owner: "Kadek"}))
	i := must[domain.Incident](t)(command.LogIncident{Deps: e.deps}.Handle(ctx, kadek, domain.IncidentInput{Kind: "accident", Severity: "low", VillaID: "vil-saka", Area: "Pool",
		OccurredAt: "2026-11-11T07:00", Description: "Slipped by the pool", People: []domain.IncidentPerson{{Kind: "staff", Name: "Made"}, {Kind: "guest", Name: "Guest", GuestID: &drop}}}))
	must[domain.Guest](t)(command.MergeGuests{Deps: e.deps}.Handle(ctx, kadek, "g-16", drop))
	c = must[domain.Complaint](t)(e.deps.Repo.Complaint(ctx, c.ID))
	i = must[domain.Incident](t)(e.deps.Repo.Incident(ctx, i.ID))
	if c.GuestID != "g-16" || len(i.People) != 2 || i.People[0].Name != "Made" || i.People[1].GuestID == nil || *i.People[1].GuestID != "g-16" {
		t.Fatalf("merge moved %+v %+v", c, i.People)
	}
}
