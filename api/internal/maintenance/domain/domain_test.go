package domain_test

import (
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// The TypeScript repo has no maintenance.test.ts; these cases follow src/domain/maintenance.ts
// and the mock adapter's work order rules line by line.

func fields(err error) map[string]string {
	if e, ok := errs.As(err); ok {
		return errs.Fields(e.Fields).Map()
	}
	return map[string]string{}
}

func str(s string) *string { return &s }

func input() domain.Input {
	return domain.Input{VillaID: "vil-saka", Category: "plumbing", Priority: "high", Title: "Leaking tap", Parts: []domain.Part{{Name: "Washer", Qty: 2, UnitCost: 5000}}, LabourCost: 50000}
}

func TestValidateWorkOrder(t *testing.T) {
	if err := domain.ValidateWorkOrder(input()); err != nil {
		t.Fatal(err)
	}
	bad := input()
	bad.Title, bad.LabourCost, bad.ScheduledOn = "Fix", 1.5, str("tomorrow")
	bad.Parts = []domain.Part{{Name: "x", Qty: 0, UnitCost: -1}}
	f := fields(domain.ValidateWorkOrder(bad))
	want := map[string]string{"title": "Say what needs fixing.", "scheduledOn": "Pick the date.", "labourCost": "Whole rupiah, zero or more.", "parts.0.name": "Name the part.", "parts.0.qty": "At least one.", "parts.0.unitCost": "Whole rupiah."}
	for k, v := range want {
		if f[k] != v {
			t.Errorf("%s = %q, want %q", k, f[k], v)
		}
	}
	if e, _ := errs.As(domain.ValidateWorkOrder(bad)); e.Message != "Say what needs fixing." {
		t.Errorf("first message = %q", e.Message)
	}
}

func TestNewWorkOrderIsScheduledWithADate(t *testing.T) {
	in := domain.NewInput{Input: input()}
	w := domain.NewWorkOrder("wo-1", "WO-501", in, "Wayan", "Wayan", "2026-11-11")
	if w.Status != domain.Open || w.Source != "manual" || len(w.History) != 1 || w.History[0].Kind != "created" || w.Cost() != 60000 {
		t.Fatalf("w = %+v", w)
	}
	in.ScheduledOn = str("2026-11-13")
	if w := domain.NewWorkOrder("wo-2", "WO-502", in, "Preventive plan", "Kadek", "2026-11-11"); w.Status != domain.Scheduled || w.History[0].By != "Kadek" {
		t.Fatalf("w = %+v", w)
	}
}

func TestTransitions(t *testing.T) {
	w := domain.NewWorkOrder("wo-1", "WO-501", domain.NewInput{Input: input()}, "Wayan", "Wayan", "2026-11-10")
	if _, _, err := w.Transition(domain.Done, "", "Kadek", "2026-11-11"); !errs.HasCode(err, "WORK_ORDER_INVALID_STATE") || err.(*errs.Error).Message != "A open job cannot become done." {
		t.Fatalf("open to done: %v", err)
	}
	if _, _, err := w.Transition(domain.InProgress, "", "Kadek", "2026-11-11"); err != nil || w.StartedOn == nil || *w.StartedOn != "2026-11-11" {
		t.Fatalf("start: %v %+v", err, w)
	}
	if _, _, err := w.Transition(domain.OnHold, "x", "Kadek", "2026-11-11"); fields(err)["note"] != "Say why." {
		t.Fatalf("hold without a reason: %v", err)
	}
	finished, release, err := w.Transition(domain.Done, "", "Kadek", "2026-11-12")
	if err != nil || !finished || !release || *w.FinishedOn != "2026-11-12" {
		t.Fatalf("done: %v %v %v", finished, release, err)
	}
	if _, _, err := w.Transition(domain.InProgress, "", "Kadek", "2026-11-12"); err != nil || w.FinishedOn != nil {
		t.Fatalf("reopen keeps the finish date: %+v", w)
	}
	_, _, _ = w.Transition(domain.Done, "", "Kadek", "2026-11-13")
	_, _, _ = w.Transition(domain.Verified, "", "Rama", "2026-11-14")
	if err := w.CheckEditable(); !errs.HasCode(err, "WORK_ORDER_INVALID_STATE") || err.(*errs.Error).Message != "WO-501 is verified; it can no longer change." {
		t.Fatalf("edit after verify: %v", err)
	}
}

func TestExpenses(t *testing.T) {
	w := domain.NewWorkOrder("wo-1", "WO-501", domain.NewInput{Input: input()}, "Wayan", "Wayan", "2026-11-10")
	if err := w.CheckCanAddExpense(); err == nil || err.(*errs.Error).Message != "WO-501 is open; expenses start once the work starts." {
		t.Fatalf("expense on an open job: %v", err)
	}
	in := domain.ExpenseInput{Kind: "vendor", Description: "Pump", Payee: "Bali Pool Care", Amount: 1500000, Method: "bank_transfer", PaidOn: "2026-11-11"}
	if fields(domain.ValidateExpense(in))["reference"] != "Enter the vendor invoice number." {
		t.Fatal("a vendor line without an invoice passes")
	}
	in.Reference = "INV-77"
	if err := domain.ValidateExpense(in); err != nil {
		t.Fatal(err)
	}
	if got := domain.ExpenseDescription("WO-501", in); got != "WO-501 vendor invoice: Pump, Bali Pool Care" {
		t.Errorf("description = %q", got)
	}
	if got := domain.ExpenseReference("WO-501", 2); got != "WO-501 / 2" {
		t.Errorf("reference = %q", got)
	}
	w.Expenses = append(w.Expenses, domain.NewExpense(w, 1, in, "tx-1", "Kadek", "2026-11-11"))
	if w.NextLine() != 2 || w.Expenses[0].ID != "exp-wo-1-1" {
		t.Fatalf("lines: %+v", w.Expenses)
	}
	in.Amount = 1200000
	w.CorrectExpense("exp-wo-1-1", in)
	if w.Expenses[0].Amount != 1200000 || w.Expenses[0].TransactionID != "tx-1" {
		t.Fatalf("correction: %+v", w.Expenses[0])
	}
}

func TestBlockChecks(t *testing.T) {
	villa := domain.NewWorkOrder("wo-1", "WO-501", domain.NewInput{Input: input()}, "Wayan", "Wayan", "2026-11-10")
	if err := villa.CheckBlock("2026-11-12", "2026-11-13"); err == nil || err.(*errs.Error).Message != "Only a job on a unit can block it." {
		t.Fatalf("villa job: %v", err)
	}
	in := input()
	in.UnitID = str("unit-sk-02")
	unit := domain.NewWorkOrder("wo-2", "WO-502", domain.NewInput{Input: in}, "Wayan", "Wayan", "2026-11-10")
	if err := unit.CheckBlock("2026-11-13", "2026-11-13"); err == nil || err.(*errs.Error).Message != "The block needs a start and a later end." {
		t.Fatalf("empty block: %v", err)
	}
	unit.Status = domain.Done
	if err := unit.CheckOpenForBlock(); err == nil || err.(*errs.Error).Message != "WO-502 is closed; it cannot block the unit." {
		t.Fatalf("closed job: %v", err)
	}
}

func TestAssetAndVendorValidators(t *testing.T) {
	a := domain.AssetInput{Code: "AC-01", Name: "Split AC", Category: "ac", VillaID: "vil-saka", PurchasedOn: str("2026-01-10"), WarrantyUntil: str("2025-12-31"), Status: "in_service"}
	if f := fields(domain.ValidateAsset(a, false)); f["warrantyUntil"] != "The warranty ends before the purchase." {
		t.Errorf("warranty: %v", f)
	}
	a.WarrantyUntil = str("2027-01-10")
	if f := fields(domain.ValidateAsset(a, true)); f["code"] != "AC-01 is already used." {
		t.Errorf("code: %v", f)
	}
	v := domain.VendorInput{Name: " Bali Pool Care ", Trade: "pool", Phone: "12", Email: "x@"}
	f := fields(domain.ValidateVendor(v, true))
	if f["name"] != "Bali Pool Care already exists." || f["phone"] == "" || f["email"] == "" {
		t.Errorf("vendor: %v", f)
	}
}

func TestPlans(t *testing.T) {
	in := domain.PlanInput{Title: "Service the AC", Category: "ac", VillaID: "vil-saka", Every: 400, Unit: "days", NextDue: "2026-11-10", Checklist: []string{"Clean filters", "Check gas"}}
	if fields(domain.ValidatePlan(in))["every"] != "At most 365 days; use months." {
		t.Fatal("400 days passes")
	}
	in.Every, in.Unit = 1, "months"
	p := domain.NewPlan("plan-1", in)
	if got := (domain.Plan{Every: 1, Unit: "months"}).AdvanceDue("2026-01-31"); got != "2026-02-28" {
		t.Errorf("advance from 31 January = %s, want 2026-02-28", got)
	}
	job := p.JobFor("2026-11-11")
	if job.Priority != "high" || job.Source != "preventive" || *job.PlanID != "plan-1" || job.Description != "Clean filters · Check gas" || *job.ScheduledOn != "2026-11-10" {
		t.Fatalf("job = %+v", job)
	}
	p.Finish("2026-11-12")
	if *p.LastDoneOn != "2026-11-12" || p.NextDue != "2026-12-12" {
		t.Fatalf("finish: %+v", p)
	}
}
