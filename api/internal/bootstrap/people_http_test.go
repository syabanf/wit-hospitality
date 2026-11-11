package bootstrap_test

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// published waits for the relay to mark an event published: the relay commits the mark after the
// in-process handlers ran, so a response can arrive just before it.
func (s server) published(t *testing.T, eventType, aggregateID string) {
	t.Helper()
	var ok bool
	var err error
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		err = s.db.Pool.QueryRow(context.Background(), `SELECT published_at IS NOT NULL FROM platform.outbox WHERE event_type = $1 AND aggregate_id = $2`, eventType, aggregateID).Scan(&ok)
		if err == nil && ok {
			return
		}
	}
	t.Fatalf("%s for %s in the outbox and published: %v %v", eventType, aggregateID, ok, err)
}

type leave struct {
	ID         string `json:"id"`
	EmployeeID string `json:"employeeId"`
	Status     string `json:"status"`
	DecidedBy  string `json:"decidedBy"`
}

type attendance struct {
	EmployeeID string `json:"employeeId"`
	Date       string `json:"date"`
	Status     string `json:"status"`
	Note       string `json:"note"`
}

type period struct {
	ID                string  `json:"id"`
	Status            string  `json:"status"`
	Published         bool    `json:"published"`
	PaidFromAccountID *string `json:"paidFromAccountId"`
	Lines             []struct {
		EmployeeID string `json:"employeeId"`
		Net        int64  `json:"net"`
	} `json:"lines"`
}

func TestLeaveRequestAndApprovalOverHTTP(t *testing.T) {
	t.Parallel()
	s := start(t)
	wayan := s.client(t)
	wayan.login("wayan")
	r := wayan.do("POST", "leave-requests", map[string]any{"employeeId": "emp-002", "kind": "permission", "from": "2026-11-11", "to": "2026-11-11", "reason": "Banjar meeting"})
	if r.status != http.StatusCreated {
		t.Fatalf("request: %d %+v", r.status, r.Error)
	}
	l := decode[leave](t, r)
	if denied := wayan.do("POST", "leave-requests/"+l.ID+"/approve", map[string]string{"note": ""}); denied.status != http.StatusForbidden || denied.Error.Message != "Staff cannot approve in HR." {
		t.Fatalf("staff approving: %d %+v", denied.status, denied.Error)
	}
	kadek := s.client(t)
	kadek.login("kadek")
	if bad := kadek.do("POST", "leave-requests/"+l.ID+"/reject", map[string]string{"note": ""}); bad.status != http.StatusUnprocessableEntity || bad.Error.Message != "Say why." {
		t.Fatalf("reject without a reason: %d %+v", bad.status, bad.Error)
	}
	r = kadek.do("POST", "leave-requests/"+l.ID+"/approve", map[string]string{"note": "Fine"})
	if got := decode[leave](t, r); r.status != http.StatusOK || got.Status != "approved" || got.DecidedBy != "Kadek Ariani" {
		t.Fatalf("approve: %d %+v", r.status, got)
	}
	if again := kadek.do("POST", "leave-requests/"+l.ID+"/cancel", map[string]string{}); again.status != http.StatusConflict || again.Error.Code != "REQUEST_INVALID_STATE" {
		t.Fatalf("decided twice: %d %+v", again.status, again.Error)
	}
	found := false
	for _, a := range decode[[]attendance](t, wayan.do("GET", "attendance", nil)) {
		if a.EmployeeID != "emp-002" {
			t.Fatalf("Wayan reads his own attendance only: %+v", a)
		}
		if a.Date == "2026-11-11" {
			found = a.Status == "leave" && a.Note != ""
		}
	}
	if !found {
		t.Fatal("approval marks today as leave")
	}
}

func TestPayrollCalculateAndCloseOverHTTP(t *testing.T) {
	t.Parallel()
	s := start(t)
	nia := s.client(t)
	nia.login("nia")
	if r := nia.do("POST", "payroll/periods/pay-2026-11/calculate", map[string]any{}); r.status != http.StatusOK || decode[period](t, r).Status != "calculated" {
		t.Fatalf("calculate: %d %+v", r.status, r.Error)
	}
	if r := nia.do("POST", "payroll/periods/pay-2026-11/approve", map[string]any{"note": ""}); r.status != http.StatusConflict || r.Error.Code != "APPROVAL_SELF" {
		t.Fatalf("self approval: %d %+v", r.status, r.Error)
	}
	ida := s.client(t)
	ida.login("ida")
	if r := ida.do("POST", "payroll/periods/pay-2026-11/approve", map[string]any{"note": ""}); r.status != http.StatusOK {
		t.Fatalf("approve: %d %+v", r.status, r.Error)
	}
	r := ida.do("POST", "payroll/periods/pay-2026-11/close", map[string]any{"note": "", "accountId": "bank-bca"})
	closed := decode[period](t, r)
	if r.status != http.StatusOK || closed.Status != "closed" || closed.PaidFromAccountID == nil || *closed.PaidFromAccountID != "bank-bca" {
		t.Fatalf("close: %d %+v", r.status, r.Error)
	}
	s.published(t, "payroll.period.closed.v1", "pay-2026-11")
	// The response waited for people's repayment handler, so the loan already shows it.
	loans := nia.do("GET", "loans", nil)
	if loans.status != http.StatusOK {
		t.Fatalf("loans: %d %+v", loans.status, loans.Error)
	}
	for _, l := range decode[[]map[string]any](t, loans) {
		if l["id"] == "ln-1" && l["repaid"] != float64(3_000_000) {
			t.Fatalf("repayment booked: %v", l)
		}
	}
	if r := nia.do("POST", "payroll/periods/pay-2026-11/publish", map[string]any{}); r.status != http.StatusOK || !decode[period](t, r).Published {
		t.Fatalf("publish: %d %+v", r.status, r.Error)
	}
	rama := s.client(t)
	rama.login("rama")
	trail := decode[[]map[string]any](t, rama.do("GET", "audit", nil))
	if trail[1]["summary"] != "Published payslips for 2026-11" || trail[1]["userId"] != "usr-nia" {
		t.Fatalf("audit line before the sign-in: %v", trail[1])
	}
}

func TestPeopleForbiddenCallsAndSelfServiceScope(t *testing.T) {
	t.Parallel()
	s := start(t)
	wayan := s.client(t)
	wayan.login("wayan")
	r := wayan.do("POST", "employees", map[string]any{"code": "EMP-016", "name": "Made Ayu", "position": "Cook", "department": "fnb", "status": "active", "joinedOn": "2026-11-01",
		"allocations": []map[string]any{{"villaId": "vil-saka", "percent": 100}}, "basicSalary": 3_400_000, "allowances": []any{}, "annualLeaveDays": 12})
	if r.status != http.StatusForbidden || r.Error.Message != "Staff cannot create in HR." {
		t.Fatalf("staff adding an employee: %d %+v", r.status, r.Error)
	}
	if r := wayan.do("PUT", "payroll/settings", map[string]any{}); r.status != http.StatusForbidden {
		t.Fatalf("staff changing payroll settings: %d", r.status)
	}
	employees := decode[[]map[string]any](t, wayan.do("GET", "employees", nil))
	if len(employees) != 1 || employees[0]["id"] != "emp-002" {
		t.Fatalf("Wayan reads his own employee record: %d", len(employees))
	}
	for _, p := range decode[[]period](t, wayan.do("GET", "payroll/periods", nil)) {
		for _, l := range p.Lines {
			if l.EmployeeID != "emp-002" || !p.Published {
				t.Fatalf("Wayan reads his own published payslips: %s %+v", p.ID, l)
			}
		}
	}
	rama := s.client(t)
	rama.login("rama")
	if n := len(decode[[]map[string]any](t, rama.do("GET", "employees", nil))); n != 15 {
		t.Fatalf("the owner reads every employee: %d", n)
	}
	if n := len(decode[[]map[string]any](t, rama.do("GET", "loans", nil))); n != 3 {
		t.Fatalf("loans: %d", n)
	}
}
