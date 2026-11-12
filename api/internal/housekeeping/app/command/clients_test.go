package command_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/adapters/clients"
	housekeepingpg "github.com/syabanf/wit-hospitality/api/internal/housekeeping/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance"
	maintenancemodule "github.com/syabanf/wit-hospitality/api/internal/maintenance/module"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// An attendant's issue and a failed inspection open work orders in maintenance, in the
// reporter's name and inside housekeeping's transaction, as the monolith wires it.
func TestAnIssueAndAFailedInspectionOpenWorkOrdersInMaintenance(t *testing.T) {
	t.Parallel()
	e := setup(t)
	makassar, _ := time.LoadLocation("Asia/Makassar")
	mm := maintenancemodule.New(maintenancemodule.Deps{DB: e.db, Clock: clock.Fixed{T: time.Date(2026, 11, 11, 10, 0, 0, 0, makassar)},
		Permissions: rbac.Static(rbac.DefaultPermissions()), Log: logging.Discard()})
	e.deps.Clients.WorkOrders = clients.WorkOrders{Client: func() maintenance.WorkOrders { return mm.WorkOrders() }}

	issue, err := command.ReportIssue{Deps: e.deps}.Handle(as(sari), sari, "hkt-103", command.IssueInput{Category: "plumbing", Title: "Shower drain blocked", Urgent: true})
	if err != nil || issue.WorkOrderID == "" || issue.Task.WorkOrderIDs[len(issue.Task.WorkOrderIDs)-1] != issue.WorkOrderID {
		t.Fatalf("issue: %v %+v", err, issue)
	}
	var title, source, priority, reportedBy, unitID string
	if err := e.db.Pool.QueryRow(context.Background(), `SELECT doc->>'title', doc->>'source', doc->>'priority', doc->>'reportedBy', doc->>'unitId' FROM maintenance.work_orders WHERE id = $1`, issue.WorkOrderID).
		Scan(&title, &source, &priority, &reportedBy, &unitID); err != nil {
		t.Fatal(err)
	}
	if title != "SK-08: Shower drain blocked" || source != "inspection" || priority != "urgent" || reportedBy != "Ni Luh Putu Sari" || unitID != "unit-sk-08" {
		t.Fatalf("work order %q %q %q %q %q", title, source, priority, reportedBy, unitID)
	}

	out, err := command.Inspect{Deps: e.deps}.Handle(as(kadek), kadek, "unit-tr-01", command.InspectInput{Results: []domain.InspectionResult{{Item: "minibar", OK: false}}, RaiseWorkOrder: true})
	if err != nil || out.WorkOrder == nil || out.WorkOrder.Number == "" {
		t.Fatalf("inspect: %v %+v", err, out)
	}
	var category string
	if err := e.db.Pool.QueryRow(context.Background(), `SELECT doc->>'category' FROM maintenance.work_orders WHERE number = $1`, out.WorkOrder.Number).Scan(&category); err != nil || category != "appliance" {
		t.Fatalf("inspection work order: %v %q", err, category)
	}
}

// Finance's answers on a laundry bill land on the batch once each: a duplicate delivery, an older
// answer and an answer for another source change nothing.
func TestFinanceAnswersLandOnTheLaundryBatch(t *testing.T) {
	t.Parallel()
	e := setup(t)
	batch, err := command.SendLaundry{Deps: e.deps}.Handle(as(kadek), kadek, domain.SendInput{VillaID: "vil-saka", Vendor: "Bersih Laundry", SentOn: today, Lines: []domain.Line{{ItemID: "stk-ln-towel", Quantity: 2}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (command.ReturnLaundry{Deps: e.deps}).Handle(as(kadek), kadek, batch.ID, domain.ReturnInput{ReturnedOn: today, Lines: []domain.ReturnLine{{ItemID: "stk-ln-towel", Returned: 2}}, Cost: 80_000, Method: "cash"}); err != nil {
		t.Fatal(err)
	}
	proj := projector.New(e.db, logging.Discard())
	housekeepingpg.Projections{DB: e.db}.Register(proj)
	b := bus.NewInProcess()
	if err := proj.Attach(b); err != nil {
		t.Fatal(err)
	}
	publish := func(id string, d housekeeping.CashOutDecided) {
		t.Helper()
		payload, _ := json.Marshal(d)
		if err := b.Publish(context.Background(), bus.Message{ID: id, Type: housekeeping.EventCashOutDecided, AggregateType: "transaction", AggregateID: d.TransactionID,
			AggregateVersion: d.Version, Payload: payload}); err != nil {
			t.Fatal(err)
		}
	}
	answer := func(status, reason string, version int64) housekeeping.CashOutDecided {
		return housekeeping.CashOutDecided{TransactionID: "tx-900", Number: "TX-900", Status: status, RejectionReason: reason, Version: version, SourceType: housekeeping.SourceLaundry, SourceID: batch.ID}
	}
	publish("00000000-0000-0000-0000-000000000001", answer("submitted", "", 1))
	publish("00000000-0000-0000-0000-000000000002", answer("rejected", "Wrong amount", 3))
	publish("00000000-0000-0000-0000-000000000002", answer("posted", "", 9))
	publish("00000000-0000-0000-0000-000000000003", answer("approved", "", 2))
	other := answer("posted", "", 10)
	other.SourceType = "maintenance_expense"
	publish("00000000-0000-0000-0000-000000000004", other)

	for _, got := range list[domain.LaundryBatch](t, e, query.Batches) {
		if got.ID != batch.ID {
			continue
		}
		if got.TransactionID == nil || *got.TransactionID != "tx-900" || got.TransactionStatus == nil || *got.TransactionStatus != "rejected" ||
			got.RejectionReason == nil || *got.RejectionReason != "Wrong amount" {
			t.Fatalf("batch after finance: %+v", got)
		}
		return
	}
	t.Fatalf("batch %s not listed", batch.ID)
}
