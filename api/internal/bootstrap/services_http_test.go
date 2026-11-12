package bootstrap_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

type orderRow struct {
	ID          string   `json:"id"`
	Number      string   `json:"number"`
	Status      string   `json:"status"`
	PlacedBy    string   `json:"placedBy"`
	VillaID     string   `json:"villaId"`
	DeliveredOn *string  `json:"deliveredOn"`
	PaymentID   *string  `json:"paymentId"`
	CostTxIDs   []string `json:"costTransactionIds"`
}

type menuRow struct {
	ID      string `json:"id"`
	VillaID string `json:"villaId"`
	Name    string `json:"name"`
}

// sakaItem finds a Saka menu item by name through GET /menu-items.
func sakaItem(t *testing.T, c *client, name string) string {
	t.Helper()
	for _, m := range decode[[]menuRow](t, c.do("GET", "menu-items", nil)) {
		if m.VillaID == "vil-saka" && m.Name == name {
			return m.ID
		}
	}
	t.Fatalf("no Saka item %s", name)
	return ""
}

func order(booking, itemID string, quantity float64, on string, at int) map[string]any {
	return map[string]any{"bookingId": booking, "lines": []map[string]any{{"itemId": itemID, "quantity": quantity}}, "note": "",
		"requestedOn": on, "requestedAt": at, "priority": "normal", "discountPct": 0, "discountReason": "", "compReason": ""}
}

func TestDeskOrderAndARefusedLeadTime(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("kadek")
	nasi := sakaItem(t, c, "Nasi goreng ayam")
	r := c.do("POST", "service-orders", order("bk-1305", nasi, 2, "2026-11-12", 12*60))
	if r.status != http.StatusCreated {
		t.Fatalf("order: %d %+v", r.status, r.Error)
	}
	o := decode[orderRow](t, r)
	if o.Number != "SO-715" || o.Status != "new" || o.PlacedBy != "staff" {
		t.Fatalf("order %+v", o)
	}
	listed := decode[[]orderRow](t, c.do("GET", "service-orders", nil))
	if len(listed) != 15 || listed[14].ID != o.ID {
		t.Fatalf("the new order reads back at once: %d rows", len(listed))
	}
	floating := sakaItem(t, c, "Floating breakfast")
	r = c.do("POST", "service-orders", order("bk-1305", floating, 1, "2026-11-11", 9*60+59))
	refused(t, r, http.StatusConflict, "ITEM_LEAD_TIME")
	if r.Error.Message != "Floating breakfast needs 12 h notice; pick 22:00 or later." {
		t.Fatalf("message %q", r.Error.Message)
	}
	refused(t, c.do("POST", "service-orders/"+o.ID+"/deliver", map[string]string{"note": ""}), http.StatusConflict, "ORDER_INVALID_STATE")
	staff := s.client(t)
	staff.login("wayan")
	refused(t, staff.do("PATCH", "menu-items/"+nasi, map[string]any{"villaId": "vil-saka", "category": "food", "name": "Nasi goreng ayam", "description": "",
		"photo": nil, "price": 80000, "unit": "item", "availableFrom": 600, "availableTo": 1320, "leadMinutes": 30, "active": true, "partnerId": nil, "costPrice": 0}), http.StatusForbidden, "FORBIDDEN")
	for _, row := range decode[[]orderRow](t, staff.do("GET", "service-orders", nil)) {
		if row.VillaID != "vil-saka" {
			t.Fatalf("staff of Saka reads %s", row.Number)
		}
	}
}

func TestGuestOrdersThroughThePublicToken(t *testing.T) {
	t.Parallel()
	s := start(t)
	desk := s.client(t)
	desk.login("kadek")
	breakfast := sakaItem(t, desk, "Balinese breakfast")
	guest := s.client(t)
	refused(t, guest.do("GET", "order/sk-04-wrong", nil), http.StatusNotFound, "NOT_FOUND")
	// orderTokenFor('SK-04') as the console prints it on the QR card of BK-1305's room.
	const tok = "sk-04-1ci1s"
	menu := decode[struct {
		Stay *struct {
			BookingCode string `json:"bookingCode"`
			GuestName   string `json:"guestName"`
		} `json:"stay"`
		Items []menuRow `json:"items"`
	}](t, guest.do("GET", "order/"+tok, nil))
	if menu.Stay == nil || menu.Stay.BookingCode != "BK-1305" || menu.Stay.GuestName != "Mia" || len(menu.Items) == 0 {
		t.Fatalf("menu %+v", menu.Stay)
	}
	r := guest.do("POST", "order/"+tok, map[string]any{"lines": []map[string]any{{"itemId": breakfast, "quantity": 2}}, "note": "Coffee black", "requestedOn": "2026-11-12", "requestedAt": 8 * 60})
	if r.status != http.StatusOK {
		t.Fatalf("guest order: %d %+v", r.status, r.Error)
	}
	after := decode[struct {
		Orders []struct {
			Number string `json:"number"`
			Charge int64  `json:"charge"`
		} `json:"orders"`
	}](t, r)
	if len(after.Orders) != 1 || after.Orders[0].Number != "SO-715" || after.Orders[0].Charge != 240_000 {
		t.Fatalf("after %+v", after.Orders)
	}
	listed := decode[[]orderRow](t, desk.do("GET", "service-orders", nil))
	if last := listed[len(listed)-1]; last.Number != "SO-715" || last.PlacedBy != "guest" {
		t.Fatalf("board %+v", last)
	}
	refused(t, guest.do("POST", "order/"+tok+"/pay", nil), http.StatusConflict, "ORDER_NOT_BILLABLE")
	refused(t, guest.do("GET", "service-orders", nil), http.StatusUnauthorized, "UNAUTHENTICATED")
}

func TestDeliveredOrderPublishesItsEvent(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("kadek")
	massage := sakaItem(t, c, "Balinese massage, 60 minutes")
	o := decode[orderRow](t, c.do("POST", "service-orders", order("bk-1305", massage, 2, "2026-11-12", 15*60)))
	for _, action := range []string{"accept", "deliver"} {
		if r := c.do("POST", "service-orders/"+o.ID+"/"+action, map[string]string{"note": ""}); r.status != http.StatusOK {
			t.Fatalf("%s: %d %+v", action, r.status, r.Error)
		}
	}
	// The relay publishes the outbox on the in-process bus; wait for the delivered event.
	deadline := time.Now().Add(5 * time.Second)
	for {
		var raw []byte
		err := s.db.Pool.QueryRow(context.Background(), `
			SELECT payload FROM platform.outbox WHERE event_type = 'services.order.delivered.v1' AND aggregate_id = $1 AND published_at IS NOT NULL`, o.ID).Scan(&raw)
		if err == nil {
			var billed struct {
				Number string `json:"number"`
				Totals struct {
					Charge int64 `json:"charge"`
					Cost   int64 `json:"cost"`
				} `json:"totals"`
				Codes []struct {
					Code   string `json:"code"`
					Amount int64  `json:"amount"`
				} `json:"codes"`
				PartnerCosts []struct {
					PartnerID string `json:"partnerId"`
					Amount    int64  `json:"amount"`
				} `json:"partnerCosts"`
			}
			if err := json.Unmarshal(raw, &billed); err != nil {
				t.Fatal(err)
			}
			if billed.Number != o.Number || billed.Totals.Charge != 600_000 || billed.Totals.Cost != 360_000 || len(billed.Codes) != 1 || billed.Codes[0].Code != "SPA" ||
				len(billed.PartnerCosts) != 1 || billed.PartnerCosts[0].PartnerID != "ptn-taksu-spa" {
				t.Fatalf("billed %s", raw)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("delivered event not published: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	listed := decode[[]orderRow](t, c.do("GET", "service-orders", nil))
	if last := listed[len(listed)-1]; last.Status != "delivered" || last.DeliveredOn == nil || *last.DeliveredOn != "2026-11-11" {
		t.Fatalf("board %+v", last)
	}
}

func TestServiceRequestPatchesAndTheInternalStayRoute(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("kadek")
	r := c.do("POST", "service-requests", map[string]any{"unitId": "unit-sk-04", "bookingId": "bk-1305", "kind": "towels", "priority": "normal", "note": "", "charge": 0})
	if r.status != http.StatusCreated {
		t.Fatalf("create: %d %+v", r.status, r.Error)
	}
	req := decode[struct {
		ID     string `json:"id"`
		Number string `json:"number"`
	}](t, r)
	if r := c.do("PATCH", "service-requests/"+req.ID, map[string]string{"assignee": "Wayan"}); r.status != http.StatusOK {
		t.Fatalf("assign: %d %+v", r.status, r.Error)
	}
	if r := c.do("POST", "service-requests/"+req.ID+"/done", nil); r.status != http.StatusOK {
		t.Fatalf("done: %d %+v", r.status, r.Error)
	}
	refused(t, c.do("POST", "service-requests/"+req.ID+"/start", nil), http.StatusConflict, "REQUEST_INVALID_STATE")
	refused(t, c.do("PATCH", "service-requests/"+req.ID, map[string]any{"unitId": "unit-sk-04", "bookingId": nil, "kind": "towels", "priority": "normal", "note": "", "charge": 0}),
		http.StatusConflict, "REQUEST_INVALID_STATE")

	// Reservation answers a split services process on /internal/v1/stays.
	internal, _ := http.NewRequest("GET", s.url[:len(s.url)-len("api/v1/")]+"internal/v1/stays/booking/bk-1305", nil)
	internal.Header.Set("X-Internal-Token", "internal")
	res, err := http.DefaultClient.Do(internal)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var stay struct {
		Data struct {
			Code    string `json:"code"`
			VillaID string `json:"villaId"`
			Status  string `json:"status"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&stay); err != nil || stay.Data.Code != "BK-1305" || stay.Data.VillaID != "vil-saka" || stay.Data.Status != "checked_in" {
		t.Fatalf("internal stay: %d %+v %v", res.StatusCode, stay, err)
	}
}
