package bootstrap_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/owners"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
)

type statementRow struct {
	ID                  string  `json:"id"`
	Number              string  `json:"number"`
	ContractID          string  `json:"contractId"`
	Month               string  `json:"month"`
	Status              string  `json:"status"`
	Payable             int64   `json:"payable"`
	PayoutTransactionID *string `json:"payoutTransactionId"`
	Figures             struct {
		NetPayable  int64 `json:"netPayable"`
		OwnerNights int64 `json:"ownerNights"`
	} `json:"figures"`
}

// outbox counts the events of one type the API appended.
func (s server) outbox(t *testing.T, eventType string) []json.RawMessage {
	t.Helper()
	rows, err := s.db.Pool.Query(context.Background(), `SELECT payload FROM platform.outbox WHERE event_type = $1 ORDER BY id`, eventType)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []json.RawMessage
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		out = append(out, raw)
	}
	return out
}

func TestOwnerStatementCloseApprovePay(t *testing.T) {
	t.Parallel()
	s := start(t)
	ida := s.client(t)
	ida.login("ida")
	var karang statementRow
	for _, st := range decode[[]statementRow](t, ida.do("GET", "owner-statements", nil)) {
		if st.Number == "OS-2026-10-PD" {
			refused(t, ida.do("POST", "owner-statements/"+st.ID+"/pay", map[string]string{"accountId": "bank-bca"}), http.StatusConflict, "PAYOUT_NOTHING")
		}
		if st.Number == "OS-2026-10-KR" {
			karang = st
		}
	}
	refused(t, ida.do("POST", "owner-statements/"+karang.ID+"/reopen", map[string]string{"reason": "Fee to be checked"}), http.StatusConflict, "PAYOUT_OPEN")
	// Finance rejects the seeded payout; owners reads it from the event.
	if err := outbox.Append(context.Background(), s.db.Pool, time.Now(), outbox.Event{Type: owners.EventFinanceEntryRejected, AggregateType: "transaction", AggregateID: *karang.PayoutTransactionID,
		Payload: owners.FinanceEntry{TransactionID: *karang.PayoutTransactionID, Number: "TX-2637", Status: "rejected"}}); err != nil {
		t.Fatal(err)
	}
	reopened := false
	for i := 0; i < 50 && !reopened; i++ {
		time.Sleep(100 * time.Millisecond)
		reopened = ida.do("POST", "owner-statements/"+karang.ID+"/reopen", map[string]string{"reason": "Fee to be checked"}).status == http.StatusOK
	}
	if !reopened {
		t.Fatal("the rejected payout lets the statement reopen")
	}
	r := ida.do("POST", "owner-statements", map[string]any{"contractId": "ct-karang", "month": "2026-10", "note": ""})
	if r.status != http.StatusCreated {
		t.Fatalf("close: %d %+v", r.status, r.Error)
	}
	closed := decode[statementRow](t, r)
	if closed.Figures.OwnerNights != 3 {
		t.Fatalf("owner nights %d", closed.Figures.OwnerNights)
	}
	if len(s.outbox(t, "owners.statement.closed.v1")) != 1 || len(s.outbox(t, "owners.statement.reopened.v1")) != 1 {
		t.Fatal("close and reopen publish their journals")
	}
	refused(t, ida.do("POST", "owner-statements/"+closed.ID+"/approve", map[string]string{"note": ""}), http.StatusConflict, "APPROVAL_ROLE")

	hendra := s.client(t)
	hendra.login("hendra")
	for _, st := range decode[[]statementRow](t, hendra.do("GET", "owner-statements", nil)) {
		if st.ID == closed.ID {
			t.Fatal("the owner sees a statement before approval")
		}
	}
	rama := s.client(t)
	rama.login("rama")
	if r := rama.do("POST", "owner-statements/"+closed.ID+"/approve", map[string]string{"note": "Agreed"}); r.status != http.StatusOK || decode[statementRow](t, r).Status != "approved" {
		t.Fatalf("approve: %d %+v", r.status, r.Error)
	}
	if len(s.outbox(t, "owners.statement.approved.v1")) != 1 {
		t.Fatal("approval publishes")
	}
	r = ida.do("POST", "owner-statements/"+closed.ID+"/pay", map[string]string{"accountId": "bank-bca"})
	if closed.Payable <= 0 || r.status != http.StatusOK {
		t.Fatalf("pay %d: %d %+v", closed.Payable, r.status, r.Error)
	}
	refused(t, ida.do("POST", "owner-statements/"+closed.ID+"/pay", map[string]string{"accountId": "bank-bca"}), http.StatusConflict, "PAYOUT_OPEN")
	requested := s.outbox(t, "owners.payout.requested.v1")
	var req struct {
		Amount    int64  `json:"amount"`
		Kind      string `json:"kind"`
		Reference string `json:"reference"`
		SourceRef string `json:"sourceRef"`
	}
	if len(requested) != 1 || json.Unmarshal(requested[0], &req) != nil || req.Amount != closed.Payable || req.Kind != "cash_out" || req.Reference != "OS-2026-10-KR" || req.SourceRef == "" {
		t.Fatalf("payout request %s", requested)
	}
	if mine := decode[[]statementRow](t, hendra.do("GET", "owner-statements", nil)); len(mine) != 4 {
		t.Fatalf("hendra reads %d statements", len(mine))
	}
}

func TestInvestorSeesNothingOperational(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("hendra")
	for _, path := range []string{"bookings", "booking-groups", "walks", "pre-checkins"} {
		r := c.do("GET", path, nil)
		refused(t, r, http.StatusForbidden, "FORBIDDEN")
		if r.Error.Message != "A villa owner sees their villas in the owner portal." {
			t.Fatalf("%s: %q", path, r.Error.Message)
		}
	}
	refused(t, c.do("POST", "owner-statements", map[string]any{"contractId": "ct-karang", "month": "2026-08"}), http.StatusForbidden, "FORBIDDEN")
	refused(t, c.do("POST", "owner-stays", map[string]any{"contractId": "ct-lumbung", "checkIn": "2027-02-10", "checkOut": "2027-02-12", "guests": 2, "note": ""}), http.StatusForbidden, "FORBIDDEN")
	contracts := decode[[]struct {
		ID string `json:"id"`
	}](t, c.do("GET", "management-contracts", nil))
	if len(contracts) != 2 {
		t.Fatalf("hendra's contracts %+v", contracts)
	}
	cal := c.do("GET", "owner-portal/calendar?from=2026-10-01&days=31", nil)
	if cal.status != http.StatusOK {
		t.Fatalf("calendar: %d %+v", cal.status, cal.Error)
	}
	var spans struct {
		Spans []map[string]any `json:"spans"`
	}
	if err := json.Unmarshal(cal.Data, &spans); err != nil || len(spans.Spans) == 0 {
		t.Fatalf("calendar %s", cal.Data)
	}
	for _, sp := range spans.Spans {
		if len(sp) != 7 || sp["guestId"] != nil {
			t.Fatalf("a span carries %v", sp)
		}
	}
	perf := c.do("GET", "owner-portal/stays", nil)
	var facts struct {
		Stays  []map[string]any `json:"stays"`
		Blocks []map[string]any `json:"blocks"`
	}
	if err := json.Unmarshal(perf.Data, &facts); perf.status != http.StatusOK || err != nil || len(facts.Stays) == 0 || len(facts.Blocks) == 0 {
		t.Fatalf("portal stays: %d %+v %s", perf.status, perf.Error, perf.Data)
	}
	for _, st := range facts.Stays {
		if len(st) != 9 || st["guestId"] != nil || st["code"] != nil {
			t.Fatalf("a stay carries %v", st)
		}
	}
	staff := s.client(t)
	staff.login("kadek")
	refused(t, staff.do("GET", "owner-portal/stays", nil), http.StatusForbidden, "FORBIDDEN")
}

func TestApprovedOwnerStayBlocksTheUnit(t *testing.T) {
	t.Parallel()
	s := start(t)
	sophie := s.client(t)
	sophie.login("sophie")
	r := sophie.do("POST", "owner-stays", map[string]any{"contractId": "ct-lumbung", "checkIn": "2027-02-10", "checkOut": "2027-02-13", "guests": 2, "note": ""})
	if r.status != http.StatusCreated {
		t.Fatalf("request: %d %+v", r.status, r.Error)
	}
	asked := decode[struct {
		ID string `json:"id"`
	}](t, r)
	kadek := s.client(t)
	kadek.login("kadek")
	r = kadek.do("POST", "owner-stays/"+asked.ID+"/decide", map[string]any{"approve": true, "unitId": "unit-lb-01", "note": ""})
	if r.status != http.StatusOK {
		t.Fatalf("decide: %d %+v", r.status, r.Error)
	}
	decided := decode[struct {
		BlockID string `json:"blockId"`
	}](t, r)
	// Property adds the owner block from the event before the answer returns (read your writes).
	found := false
	for _, b := range decode[[]struct {
		ID     string `json:"id"`
		Reason string `json:"reason"`
	}](t, kadek.do("GET", "unit-blocks", nil)) {
		found = found || (b.ID == decided.BlockID && b.Reason == "owner")
	}
	if !found {
		t.Fatalf("no owner block %s", decided.BlockID)
	}
	refused(t, kadek.do("POST", "bookings", stay("unit-lb-01", "", "2027-02-11", "2027-02-12")), http.StatusConflict, "BOOKING_OVERLAP")
}

func (c *client) upload(name, contentType string, data []byte) reply {
	c.t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", `form-data; name="file"; filename="`+name+`"`)
	h.Set("Content-Type", contentType)
	part, _ := w.CreatePart(h)
	_, _ = part.Write(data)
	_ = w.Close()
	req, _ := http.NewRequest("POST", c.base+"files", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	res, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := reply{status: res.StatusCode}
	if err := json.Unmarshal(raw, &out); err != nil {
		c.t.Fatalf("upload: %d %s", res.StatusCode, raw)
	}
	return out
}

func TestFileUpload(t *testing.T) {
	t.Setenv("FILES_DIR", t.TempDir())
	s := start(t)
	c := s.client(t)
	c.login("ida")
	pdf := []byte("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n")
	r := c.upload("receipt.pdf", "application/pdf", pdf)
	if r.status != http.StatusCreated {
		t.Fatalf("upload: %d %+v", r.status, r.Error)
	}
	a := decode[struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		Type       string `json:"type"`
		Size       int64  `json:"size"`
		URL        string `json:"url"`
		UploadedBy string `json:"uploadedBy"`
		UploadedAt string `json:"uploadedAt"`
	}](t, r)
	if a.Name != "receipt.pdf" || a.Type != "application/pdf" || a.Size != int64(len(pdf)) || a.UploadedBy != "Ida Bagus Rai" || a.URL != "http://localhost:8080/api/v1/files/"+a.ID || len(a.UploadedAt) != 19 {
		t.Fatalf("attachment %+v", a)
	}
	res, err := c.http.Get(c.base + "files/" + a.ID)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || res.Header.Get("Content-Type") != "application/pdf" || !bytes.Equal(got, pdf) {
		t.Fatalf("download: %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	refused(t, c.upload("notes.txt", "text/plain", []byte("hello")), http.StatusConflict, "ATTACHMENT_TYPE")
	refused(t, c.upload("empty.png", "image/png", nil), http.StatusConflict, "ATTACHMENT_EMPTY")
	refused(t, c.upload("big.jpg", "image/jpeg", make([]byte, 5*1024*1024+1)), http.StatusConflict, "ATTACHMENT_SIZE")
	guest := s.client(t)
	if r := guest.upload("slip.jpg", "image/jpeg", []byte{0xff, 0xd8, 0xff, 0xe0}); r.status != http.StatusCreated || decode[struct {
		UploadedBy string `json:"uploadedBy"`
	}](t, r).UploadedBy != "Guest" {
		t.Fatalf("guest upload: %d %+v", r.status, r.Error)
	}
	if res, _ := guest.http.Get(c.base + "files/" + a.ID); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("a file needs a session: %d", res.StatusCode)
	}
	if res, _ := c.http.Get(c.base + "files/" + a.ID + ".meta"); res.StatusCode != http.StatusNotFound {
		t.Fatalf("the stored attachment is not served: %d", res.StatusCode)
	}

	// Finance resolves the upload by id through the files client.
	kadek := s.client(t)
	kadek.login("kadek")
	tx := decode[entryRow](t, kadek.do("POST", "transactions", cashOutBody(400_000)))
	r = kadek.do("POST", "transactions/"+tx.ID+"/attachments", map[string]any{"attachmentIds": []string{a.ID}})
	if r.status != http.StatusOK {
		t.Fatalf("attach by id: %d %+v", r.status, r.Error)
	}
	attached := decode[struct {
		Attachments []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
			Size int64  `json:"size"`
		} `json:"attachments"`
	}](t, r).Attachments
	if len(attached) != 1 || attached[0].ID != a.ID || attached[0].Name != "receipt.pdf" || attached[0].Size != int64(len(pdf)) {
		t.Fatalf("attached %+v", attached)
	}
	refused(t, kadek.do("POST", "transactions/"+tx.ID+"/attachments", map[string]any{"attachmentIds": []string{"file-missing"}}), http.StatusNotFound, "NOT_FOUND")

	// A split service asks the files service on /internal/v1/files.
	internal := func(query string) (int, string) {
		req, _ := http.NewRequest("GET", s.url[:len(s.url)-len("api/v1/")]+"internal/v1/files?"+query, nil)
		req.Header.Set("X-Internal-Token", "internal")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(raw)
	}
	if status, body := internal("id=" + a.ID); status != http.StatusOK || !strings.Contains(body, `"name":"receipt.pdf"`) {
		t.Fatalf("internal resolve: %d %s", status, body)
	}
	if status, _ := internal("id=file-missing"); status != http.StatusNotFound {
		t.Fatalf("internal resolve of an unknown id: %d", status)
	}
}
