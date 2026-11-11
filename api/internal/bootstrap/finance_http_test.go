package bootstrap_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/finance/domain"
)

type entryRow struct {
	ID          string `json:"id"`
	Number      string `json:"number"`
	Status      string `json:"status"`
	Kind        string `json:"kind"`
	Amount      int64  `json:"amount"`
	Attachments []struct {
		ID string `json:"id"`
	} `json:"attachments"`
}

func cashOutBody(amount int64, attachments ...map[string]any) map[string]any {
	if attachments == nil {
		attachments = []map[string]any{}
	}
	return map[string]any{"accountId": "cb-ubud", "kind": "cash_out", "categoryId": "cat-util", "amount": amount, "date": "2026-11-11", "locationId": "loc-ubud",
		"villaId": "vil-tirta", "unitId": nil, "bookingId": nil, "description": "Generator service", "reference": "INV-77", "attachments": attachments, "submit": true, "origin": "manual"}
}

var invoice = map[string]any{"id": "file-1", "name": "invoice.pdf", "type": "application/pdf", "size": 2048, "url": "https://files.example/invoice.pdf", "uploadedBy": "Kadek Ariani", "uploadedAt": "2026-11-11T09:00:00"}

// checkBooks reads the books back over HTTP and holds them to the accounting.test.ts invariants.
func checkBooks(t *testing.T, c *client) {
	t.Helper()
	accounts := decode[[]domain.CashAccount](t, c.do("GET", "cash-accounts", nil))
	txs := decode[[]domain.Transaction](t, c.do("GET", "transactions", nil))
	chart := decode[[]domain.GlAccount](t, c.do("GET", "ledger/accounts", nil))
	entries := decode[[]domain.JournalEntry](t, c.do("GET", "ledger/journals", nil))
	for _, p := range domain.BooksProblems(chart, accounts, txs, entries, "2026-11-11") {
		t.Error(p)
	}
}

func TestCashOutWithProofApprovalPostingAndReversal(t *testing.T) {
	t.Parallel()
	s := start(t)
	kadek, rama := s.client(t), s.client(t)
	kadek.login("kadek")
	rama.login("rama")

	r := kadek.do("POST", "transactions", cashOutBody(2_400_000))
	refused(t, r, http.StatusConflict, "PROOF_REQUIRED")
	if r.Error.Message != "Attach a receipt or invoice: cash-outs from Rp 1.000.000 need proof before approval." {
		t.Fatalf("message %q", r.Error.Message)
	}
	r = kadek.do("POST", "transactions", cashOutBody(2_400_000, invoice))
	if r.status != http.StatusCreated {
		t.Fatalf("create: %d %+v", r.status, r.Error)
	}
	tx := decode[entryRow](t, r)
	if tx.Status != "submitted" || tx.Number != "TX-2641" || len(tx.Attachments) != 1 {
		t.Fatalf("entry %+v", tx)
	}
	refused(t, kadek.do("POST", "transactions/"+tx.ID+"/approve", map[string]string{"note": ""}), http.StatusConflict, "APPROVAL_SELF")
	refused(t, kadek.do("POST", "transactions/"+tx.ID+"/post", map[string]string{"note": ""}), http.StatusForbidden, "FORBIDDEN")
	if r := rama.do("POST", "transactions/"+tx.ID+"/approve", map[string]string{"note": "ok"}); r.status != 200 || decode[entryRow](t, r).Status != "approved" {
		t.Fatalf("approve: %d %+v", r.status, r.Error)
	}
	if r := rama.do("POST", "transactions/"+tx.ID+"/post", map[string]string{"note": ""}); r.status != 200 || decode[entryRow](t, r).Status != "posted" {
		t.Fatalf("post: %d %+v", r.status, r.Error)
	}
	refused(t, kadek.do("DELETE", "transactions/"+tx.ID+"/attachments/file-1", nil), http.StatusConflict, "ATTACHMENT_LOCKED")
	refused(t, rama.do("POST", "transactions/"+tx.ID+"/approve", map[string]string{"note": ""}), http.StatusConflict, "TRANSACTION_ALREADY_POSTED")

	entries := decode[[]domain.JournalEntry](t, rama.do("GET", "ledger/journals", nil))
	last := entries[len(entries)-1]
	if last.SourceID != tx.ID || last.Number != "JE-00296" || last.Lines[0].AccountID != "gl-6200" || last.Lines[0].Debit != 2_400_000 {
		t.Fatalf("journal %+v", last)
	}
	r = rama.do("POST", "transactions/"+tx.ID+"/reverse", map[string]string{"reason": "Billed twice"})
	if r.status != 200 {
		t.Fatalf("reverse: %d %+v", r.status, r.Error)
	}
	if rev := decode[entryRow](t, r); rev.Kind != "cash_in" || rev.Status != "posted" {
		t.Fatalf("reversal %+v", rev)
	}
	checkBooks(t, rama)
}

func TestPeriodCloseRefusalOverHTTP(t *testing.T) {
	t.Parallel()
	s := start(t)
	ida := s.client(t)
	ida.login("ida")
	refused(t, ida.do("POST", "ledger/periods/2026-11/close", map[string]string{"note": ""}), http.StatusConflict, "PERIOD_NOT_ENDED")
	if r := ida.do("POST", "ledger/periods/2026-08/close", map[string]string{"note": "August final"}); r.status != 200 {
		t.Fatalf("close: %d %+v", r.status, r.Error)
	}
	r := ida.do("POST", "transactions/adjustments", map[string]any{"accountId": "cb-ubud", "direction": "increase", "amount": 10_000, "date": "2026-08-20", "reason": "Found in the drawer"})
	adj := decode[entryRow](t, r)
	rama := s.client(t)
	rama.login("rama")
	rama.do("POST", "transactions/"+adj.ID+"/approve", map[string]string{"note": ""})
	r = ida.do("POST", "transactions/"+adj.ID+"/post", map[string]string{"note": ""})
	refused(t, r, http.StatusConflict, "PERIOD_CLOSED")
	if r.Error.Message != "August 2026 is closed; reopen it before posting into it." {
		t.Fatalf("message %q", r.Error.Message)
	}
	if r := ida.do("POST", "ledger/periods/2026-08/reopen", map[string]string{"reason": "Late count"}); r.status != http.StatusNoContent {
		t.Fatalf("reopen: %d %+v", r.status, r.Error)
	}
	if r := ida.do("POST", "transactions/"+adj.ID+"/post", map[string]string{"note": ""}); r.status != 200 {
		t.Fatalf("post after reopen: %d %+v", r.status, r.Error)
	}
	checkBooks(t, ida)
}

func TestShiftCloseWithSignOffOverHTTP(t *testing.T) {
	t.Parallel()
	s := start(t)
	kadek, rama := s.client(t), s.client(t)
	kadek.login("kadek")
	rama.login("rama")
	r := kadek.do("POST", "cashier-shifts", map[string]any{"accountId": "cb-ubud", "count": map[string]any{"notes": map[string]int{"100000": 10}, "coins": 0}, "handOverFrom": nil})
	if r.status != http.StatusCreated {
		t.Fatalf("open: %d %+v", r.status, r.Error)
	}
	sh := decode[domain.CashierShift](t, r)
	r = kadek.do("POST", "cashier-shifts/"+sh.ID+"/close", map[string]any{"count": map[string]any{"notes": map[string]int{"100000": 9}, "coins": 0}, "reason": ""})
	refused(t, r, http.StatusConflict, "SHIFT_REASON_REQUIRED")
	r = kadek.do("POST", "cashier-shifts/"+sh.ID+"/close", map[string]any{"count": map[string]any{"notes": map[string]int{"100000": 9}, "coins": 0}, "reason": "Paid a supplier from the drawer"})
	if sh = decode[domain.CashierShift](t, r); sh.Status != "awaiting_signoff" || *sh.Difference != -100_000 {
		t.Fatalf("close: %+v", sh)
	}
	refused(t, kadek.do("POST", "cashier-shifts/"+sh.ID+"/sign-off", map[string]string{"note": ""}), http.StatusConflict, "SHIFT_SELF_SIGNOFF")
	r = rama.do("POST", "cashier-shifts/"+sh.ID+"/sign-off", map[string]string{"note": "Receipt found"})
	if sh = decode[domain.CashierShift](t, r); sh.Status != "closed" || sh.ReconciliationID == nil {
		t.Fatalf("sign-off: %d %+v", r.status, sh)
	}
	recs := decode[[]domain.Reconciliation](t, rama.do("GET", "reconciliations", nil))
	if last := recs[len(recs)-1]; last.Difference != -100_000 || last.AdjustmentID == nil {
		t.Fatalf("count %+v", last)
	}
}

func TestManualJournalSignedAndPostedOverHTTP(t *testing.T) {
	t.Parallel()
	s := start(t)
	ida, kadek := s.client(t), s.client(t)
	ida.login("ida")
	kadek.login("kadek")
	lines := []map[string]any{{"accountId": "gl-1200", "debit": 2_000_000, "credit": 0}, {"accountId": "gl-4100", "debit": 0, "credit": 1_000_000}}
	body := map[string]any{"date": "2026-11-11", "villaId": "vil-saka", "memo": "Accrue an unpaid stay", "lines": lines, "attachments": []any{}, "attachmentIds": []string{}, "submit": true}
	refused(t, ida.do("POST", "ledger/manual-journals", body), http.StatusConflict, "JOURNAL_UNBALANCED")
	lines[1]["credit"] = 2_000_000
	r := ida.do("POST", "ledger/manual-journals", body)
	if r.status != http.StatusCreated {
		t.Fatalf("create: %d %+v", r.status, r.Error)
	}
	m := decode[domain.ManualJournal](t, r)
	if m.Number != "MJ-0001" || m.Status != "submitted" {
		t.Fatalf("journal %+v", m)
	}
	refused(t, ida.do("POST", "ledger/manual-journals/"+m.ID+"/approve", map[string]string{"note": ""}), http.StatusConflict, "APPROVAL_SELF")
	if r := kadek.do("POST", "ledger/manual-journals/"+m.ID+"/approve", map[string]string{"note": ""}); r.status != 200 || decode[domain.ManualJournal](t, r).Status != "approved" {
		t.Fatalf("approve: %d %+v", r.status, r.Error)
	}
	r = ida.do("POST", "ledger/manual-journals/"+m.ID+"/post", map[string]string{"note": ""})
	if m = decode[domain.ManualJournal](t, r); m.Status != "posted" || m.JournalID == nil {
		t.Fatalf("post: %+v", m)
	}
	listed := decode[[]domain.ManualJournal](t, kadek.do("GET", "ledger/manual-journals", nil))
	if len(listed) != 1 || listed[0].Status != "posted" {
		t.Fatalf("listed %+v", listed)
	}
	checkBooks(t, ida)
}

func TestFinanceClientInternalRoutes(t *testing.T) {
	t.Parallel()
	s := start(t)
	req, _ := http.NewRequest("GET", s.url[:len(s.url)-len("api/v1/")]+"internal/v1/finance/entries?sourceType=payroll&sourceId=pay-2026-10", nil)
	req.Header.Set("X-Internal-Token", "internal")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body struct {
		Data []struct {
			Number string `json:"number"`
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil || res.StatusCode != 200 || len(body.Data) != 1 || body.Data[0].Status != "posted" {
		t.Fatalf("entries: %d %v %+v", res.StatusCode, err, body)
	}
}
