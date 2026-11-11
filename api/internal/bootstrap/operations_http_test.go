package bootstrap_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/inventory"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
)

type expenseLine struct {
	ID            string `json:"id"`
	Line          int    `json:"line"`
	Amount        int64  `json:"amount"`
	TransactionID string `json:"transactionId"`
}

type workOrder struct {
	ID       string        `json:"id"`
	Number   string        `json:"number"`
	Status   string        `json:"status"`
	BlockID  *string       `json:"blockId"`
	Expenses []expenseLine `json:"expenses"`
}

type stockReceipt struct {
	ID            string  `json:"id"`
	Number        string  `json:"number"`
	TransactionID *string `json:"transactionId"`
	Lines         []struct {
		Quantity int `json:"quantity"`
	} `json:"lines"`
}

type stockItem struct {
	ID          string `json:"id"`
	AverageCost int64  `json:"averageCost"`
}

func averageOf(t *testing.T, c *client, id string) int64 {
	t.Helper()
	for _, i := range decode[[]stockItem](t, c.do("GET", "stock/items", nil)) {
		if i.ID == id {
			return i.AverageCost
		}
	}
	t.Fatalf("no stock item %s", id)
	return 0
}

// rejectCashOut publishes finance's rejection and waits until inventory has applied it.
func rejectCashOut(t *testing.T, s server, id string) {
	t.Helper()
	err := s.db.InTx(context.Background(), func(ctx context.Context) error {
		return outbox.Append(ctx, s.db.Q(ctx), time.Now(), outbox.Event{Type: inventory.EventCashOutDecided, AggregateType: "cash_out", AggregateID: id, AggregateVersion: 1,
			Payload: inventory.CashOutDecided{TransactionID: id, Status: "rejected", RejectionReason: "Wrong price", Version: 1}})
	})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		var status string
		_ = s.db.Pool.QueryRow(context.Background(), `SELECT status FROM inventory.cash_outs WHERE id = $1`, id).Scan(&status)
		if status == "rejected" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("cash-out %s still %s", id, status)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestWorkOrderWithASubmittedExpense(t *testing.T) {
	s := start(t)
	c := s.client(t)
	c.login("kadek")
	body := map[string]any{
		"villaId": "vil-saka", "unitId": "unit-sk-02", "assetId": nil, "category": "plumbing", "priority": "high", "title": "Leaking shower mixer",
		"description": "", "assigneeId": nil, "vendorId": nil, "scheduledOn": nil, "parts": []any{}, "labourCost": 0, "vendorCost": 0,
		"beforePhotos": []any{}, "afterPhotos": []any{}, "blockFrom": "2026-11-12", "blockTo": "2026-11-14",
	}
	r := c.do("POST", "work-orders", body)
	if r.status != http.StatusCreated {
		t.Fatalf("create: %d %+v", r.status, r.Error)
	}
	w := decode[workOrder](t, r)
	if w.Number != "WO-519" || w.BlockID == nil {
		t.Fatalf("work order %+v", w)
	}
	blocks := decode[[]struct {
		ID string `json:"id"`
	}](t, c.do("GET", "unit-blocks", nil))
	found := false
	for _, b := range blocks {
		found = found || b.ID == *w.BlockID
	}
	if !found {
		t.Fatal("the block is not on the unit blocks page")
	}
	expense := map[string]any{"kind": "parts", "description": "Cartridge", "payee": "", "vendorId": nil, "amount": 350000, "method": "cash", "reference": "", "receipts": []any{}, "paidOn": "2026-11-11"}
	if r := c.do("POST", "work-orders/"+w.ID+"/expenses", expense); r.status != http.StatusConflict || r.Error.Code != "WORK_ORDER_INVALID_STATE" {
		t.Fatalf("expense before the work starts: %d %+v", r.status, r.Error)
	}
	if r := c.do("POST", "work-orders/"+w.ID+"/status", map[string]string{"status": "in_progress", "note": ""}); r.status != http.StatusOK {
		t.Fatalf("start: %d %+v", r.status, r.Error)
	}
	if r := c.do("POST", "work-orders/"+w.ID+"/expenses", expense); r.status != http.StatusUnprocessableEntity || r.Error.Message != "Name the shop, vendor or person paid." {
		t.Fatalf("expense without a payee: %d %+v", r.status, r.Error)
	}
	expense["payee"] = "Toko Bangunan"
	r = c.do("POST", "work-orders/"+w.ID+"/expenses", expense)
	if r.status != http.StatusCreated {
		t.Fatalf("expense: %d %+v", r.status, r.Error)
	}
	paid := decode[workOrder](t, r)
	if len(paid.Expenses) != 1 || paid.Expenses[0].Line != 1 || paid.Expenses[0].TransactionID == "" {
		t.Fatalf("expense %+v", paid.Expenses)
	}
	var amount string
	if err := s.db.Pool.QueryRow(context.Background(), `SELECT payload->>'amount' FROM platform.outbox WHERE event_type = 'maintenance.expense.submitted.v1'`).Scan(&amount); err != nil || amount != "350000" {
		t.Fatalf("expense.submitted: %v %s", err, amount)
	}
	c.login("rama")
	var summary string
	if err := s.db.Pool.QueryRow(context.Background(), `SELECT summary FROM platform.audit_log WHERE entity = 'transaction' ORDER BY at DESC, id DESC LIMIT 1`).Scan(&summary); err != nil || !strings.HasPrefix(summary, "Submitted TX-M") {
		t.Fatalf("audit line: %v %q", err, summary)
	}
}

func TestStockShortRefusal(t *testing.T) {
	s := start(t)
	c := s.client(t)
	c.login("kadek")
	r := c.do("POST", "stock/movements", map[string]any{"kind": "write_off", "villaId": "vil-saka", "unitId": nil, "toVillaId": nil, "lines": []map[string]any{{"itemId": "stk-am-soap", "quantity": 100000}}, "reason": "Damaged"})
	if r.status != http.StatusConflict || r.Error.Code != "STOCK_SHORT" || !strings.HasPrefix(r.Error.Message, "Villa Saka holds ") || !strings.HasSuffix(r.Error.Message, "Bar soap; 100000 cannot leave the store.") {
		t.Fatalf("write-off: %d %+v", r.status, r.Error)
	}
	c.login("wayan")
	r = c.do("POST", "stock/movements", map[string]any{"kind": "write_off", "villaId": "vil-tirta", "unitId": nil, "toVillaId": nil, "lines": []map[string]any{{"itemId": "stk-am-soap", "quantity": 1}}, "reason": "Damaged"})
	if r.status != http.StatusForbidden {
		t.Fatalf("Wayan writes off in Ubud: %d %+v", r.status, r.Error)
	}
}

func TestReceiptCorrectionAfterRejection(t *testing.T) {
	s := start(t)
	c := s.client(t)
	c.login("kadek")
	item := decode[stockItem](t, c.do("POST", "stock/items", map[string]any{"code": "AM-TEST-SOAP", "name": "Test soap", "kind": "amenity", "unit": "piece", "reorderLevel": 0, "par": 0, "active": true}))
	receive := func(quantity, unitCost int) stockReceipt {
		r := c.do("POST", "stock/receipts", map[string]any{"villaId": "vil-saka", "supplier": "Pepito Market", "lines": []map[string]any{{"itemId": item.ID, "quantity": quantity, "unitCost": unitCost}}, "method": "cash", "reference": "", "attachments": []any{}, "receivedOn": "2026-11-11"})
		if r.status != http.StatusCreated {
			t.Fatalf("receive: %d %+v", r.status, r.Error)
		}
		return decode[stockReceipt](t, r)
	}
	receive(10, 10000)
	second := receive(10, 20000)
	if avg := averageOf(t, c, item.ID); avg != 15000 {
		t.Fatalf("average = %d", avg)
	}
	fix := map[string]any{"supplier": "Pepito Market", "lines": []map[string]any{{"itemId": item.ID, "quantity": 5, "unitCost": 16000}}, "method": "cash", "reference": "PPT/5", "attachments": []any{}, "receivedOn": "2026-11-11"}
	if r := c.do("PUT", "stock/receipts/"+second.ID, fix); r.status != http.StatusConflict || r.Error.Code != "TRANSACTION_INVALID_STATE" {
		t.Fatalf("correct a submitted purchase: %d %+v", r.status, r.Error)
	}
	rejectCashOut(t, s, *second.TransactionID)
	r := c.do("PUT", "stock/receipts/"+second.ID, fix)
	if r.status != http.StatusOK {
		t.Fatalf("correct: %d %+v", r.status, r.Error)
	}
	if fixed := decode[stockReceipt](t, r); len(fixed.Lines) != 1 || fixed.Lines[0].Quantity != 5 {
		t.Fatalf("corrected receipt %+v", fixed)
	}
	if avg := averageOf(t, c, item.ID); avg != 12000 {
		t.Fatalf("average after the correction = %d, want 12,000", avg)
	}
}

func TestStockCount(t *testing.T) {
	s := start(t)
	c := s.client(t)
	c.login("kadek")
	r := c.do("POST", "stock/counts", map[string]any{"villaId": "vil-saka", "countedBy": "Kadek Ariani", "lines": []map[string]any{{"itemId": "stk-am-soap", "counted": 3}}, "note": ""})
	if r.status != http.StatusCreated {
		t.Fatalf("count: %d %+v", r.status, r.Error)
	}
	count := decode[struct {
		Number string `json:"number"`
		Lines  []struct {
			Expected int   `json:"expected"`
			Counted  int   `json:"counted"`
			UnitCost int64 `json:"unitCost"`
		} `json:"lines"`
	}](t, r)
	if count.Number != "SC-102" || count.Lines[0].Counted != 3 || count.Lines[0].Expected <= 3 || count.Lines[0].UnitCost == 0 {
		t.Fatalf("count %+v", count)
	}
	moves := decode[[]struct {
		Kind     string `json:"kind"`
		Quantity int    `json:"quantity"`
		By       string `json:"by"`
	}](t, c.do("GET", "stock/movements", nil))
	last := moves[len(moves)-1]
	if last.Kind != "adjustment" || last.Quantity != 3-count.Lines[0].Expected || last.By != "Kadek Ariani" {
		t.Fatalf("adjustment %+v", last)
	}
	if r := c.do("POST", "stock/counts", map[string]any{"villaId": "vil-saka", "countedBy": "K", "lines": []any{}, "note": ""}); r.status != http.StatusUnprocessableEntity || r.Error.Message != "Name who counted." {
		t.Fatalf("bad count: %d %+v", r.status, r.Error)
	}
}
