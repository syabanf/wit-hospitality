package bootstrap_test

import (
	"context"
	"net/http"
	"testing"

	billingpg "github.com/syabanf/wit-hospitality/api/internal/billing/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/platform/snapshot"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	reservationdomain "github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

type window struct {
	Mode string `json:"mode"`
	From string `json:"from"`
	To   string `json:"to"`
}

type hostedStay struct {
	ID            string  `json:"id"`
	HostID        *string `json:"hostId"`
	ServiceWindow window  `json:"serviceWindow"`
	Preferences   struct {
		BreakfastTime string   `json:"breakfastTime"`
		Setups        []string `json:"setups"`
		ArrivalTime   string   `json:"arrivalTime"`
		Notes         string   `json:"notes"`
	} `json:"preferences"`
	LateCheckout *struct {
		Until  string `json:"until"`
		Charge int64  `json:"charge"`
	} `json:"lateCheckout"`
}

type hkTask struct {
	ID            string  `json:"id"`
	Type          string  `json:"type"`
	Status        string  `json:"status"`
	BookingID     *string `json:"bookingId"`
	ServiceWindow *window `json:"serviceWindow"`
}

func created[T any](t *testing.T, r reply, what string) T {
	t.Helper()
	if r.status != http.StatusCreated && r.status != http.StatusOK {
		t.Fatalf("%s: %d %+v", what, r.status, r.Error)
	}
	return decode[T](t, r)
}

// withHost is the unit's form as GET /units serves it, with a host.
func withHost(t *testing.T, c *client, unitID string, host any) map[string]any {
	t.Helper()
	for _, u := range decode[[]map[string]any](t, c.do("GET", "units", nil)) {
		if u["id"] == unitID {
			u["hostId"] = host
			return u
		}
	}
	t.Fatalf("no unit %s", unitID)
	return nil
}

// A villa unit's host (TR-04 in Tirta, hosted by Putu) follows its stays; the host lists them, setups reach the host as requests,
// the service window reaches housekeeping's tasks and do not disturb holds the door until a
// supervisor gives a reason. A villa leaves late for free when nobody arrives.
func TestVillaHostPreferencesAndServiceWindow(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("rama")
	refused(t, c.do("PATCH", "units/unit-tr-04", withHost(t, c, "unit-tr-04", "emp-011")), http.StatusConflict, "HOST_NOT_ALLOCATED")
	u := created[map[string]any](t, c.do("PATCH", "units/unit-tr-04", withHost(t, c, "unit-tr-04", "emp-008")), "host")
	if u["hostId"] != "emp-008" {
		t.Fatalf("unit host %v", u["hostId"])
	}
	b := created[hostedStay](t, c.do("POST", "bookings", stay("unit-tr-04", "", "2027-05-01", "2027-05-04")), "booking")
	if b.HostID == nil || *b.HostID != "emp-008" || b.ServiceWindow != (window{"window", "10:00", "12:00"}) || b.Preferences.Setups == nil {
		t.Fatalf("villa stay %+v", b)
	}

	putu := s.client(t)
	putu.login("putu")
	hosted := decode[[]hostedStay](t, putu.do("GET", "host-stays", nil))
	if len(hosted) != 1 || hosted[0].ID != b.ID {
		t.Fatalf("host stays %+v", hosted)
	}
	refused(t, c.do("PATCH", "bookings/"+b.ID+"/host", map[string]any{"hostId": "emp-011"}), http.StatusConflict, "HOST_NOT_ALLOCATED")

	prefs := map[string]any{"breakfastTime": "08:00", "dietary": "No pork", "setups": []string{"bbq", "airport_pickup"}, "arrivalTime": "16:00", "notes": ""}
	if p := created[hostedStay](t, c.do("PATCH", "bookings/"+b.ID+"/preferences", prefs), "preferences"); len(p.Preferences.Setups) != 2 {
		t.Fatalf("preferences %+v", p.Preferences)
	}
	requests := 0
	for _, r := range decode[[]map[string]any](t, c.do("GET", "service-requests", nil)) {
		if r["bookingId"] == b.ID && r["assignee"] == "Putu Eka Wijaya" && r["status"] == "open" {
			requests++
		}
	}
	if requests != 2 {
		t.Fatalf("setup requests for the host: %d", requests)
	}

	if r := c.do("POST", "bookings/"+b.ID+"/check-in", nil); r.status != http.StatusOK {
		t.Fatalf("check in: %d %+v", r.status, r.Error)
	}
	refused(t, c.do("POST", "bookings/"+b.ID+"/service-requests", map[string]any{"kind": "towels"}), http.StatusUnprocessableEntity, "VALIDATION_ERROR")
	task := created[hkTask](t, c.do("POST", "bookings/"+b.ID+"/service-requests", map[string]any{"kind": "clean"}), "clean")
	if task.Type != "stayover" || task.BookingID == nil || *task.BookingID != b.ID || task.ServiceWindow == nil || task.ServiceWindow.Mode != "window" {
		t.Fatalf("clean task %+v", task)
	}
	cleaning := 0
	for _, r := range decode[[]map[string]any](t, c.do("GET", "service-requests", nil)) {
		if r["bookingId"] == b.ID && r["kind"] == "cleaning" {
			cleaning++
		}
	}
	if again := created[hkTask](t, c.do("POST", "bookings/"+b.ID+"/service-requests", map[string]any{"kind": "clean"}), "clean again"); again.ID != task.ID || cleaning != 1 {
		t.Fatalf("one stayover and one cleaning request: %s %d", again.ID, cleaning)
	}
	refused(t, c.do("PATCH", "bookings/"+b.ID, map[string]any{"serviceWindow": map[string]any{"mode": "window", "from": "13:00", "to": "12:00"}}), http.StatusUnprocessableEntity, "VALIDATION_ERROR")
	if w := created[hostedStay](t, c.do("PATCH", "bookings/"+b.ID, map[string]any{"serviceWindow": map[string]any{"mode": "dnd"}}), "dnd"); w.ServiceWindow.Mode != "dnd" {
		t.Fatalf("window %+v", w.ServiceWindow)
	}
	for _, x := range decode[[]hkTask](t, c.do("GET", "housekeeping/tasks", nil)) {
		if x.ID == task.ID && (x.ServiceWindow == nil || x.ServiceWindow.Mode != "dnd") {
			t.Fatalf("the open task takes the new window: %+v", x)
		}
	}
	refused(t, c.do("POST", "housekeeping/tasks/"+task.ID+"/start", map[string]any{}), http.StatusConflict, "TASK_DND")
	if started := created[hkTask](t, c.do("POST", "housekeeping/tasks/"+task.ID+"/start", map[string]any{"overrideReason": "Smoke alarm beeping"}), "override"); started.Status != "in_progress" {
		t.Fatalf("override %+v", started)
	}

	given := created[struct {
		Charge  int64      `json:"charge"`
		Booking hostedStay `json:"booking"`
	}](t, c.do("POST", "bookings/"+b.ID+"/late-checkout", map[string]any{"until": "15:00"}), "late check-out")
	if given.Charge != 0 || given.Booking.LateCheckout == nil || given.Booking.LateCheckout.Until != "15:00" {
		t.Fatalf("villa late check-out %+v", given)
	}
}

// A hotel room pays the late check-out fee on its folio; an arrival before the time refuses it.
func TestRoomLateCheckoutChargesTheFolio(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("rama")
	zero := 0
	id := createProperty(t, c, map[string]any{
		"villa":  propertyVilla("HL", "Hotel Lestari", map[string]any{"operation": "hotel"}),
		"groups": []map[string]any{{"name": "Standard"}},
		"rooms":  []map[string]any{wizardRoom("HL-101", "Room 101", "1", 1, 800_000, &zero)},
	})
	for _, v := range decode[[]map[string]any](t, c.do("GET", "villas", nil)) {
		if v["id"] == id && v["lateCheckoutFee"] != 500_000.0 {
			t.Fatalf("hotel fee %v", v["lateCheckoutFee"])
		}
	}
	refused(t, c.do("PATCH", "units/unit-hl-101", withHost(t, c, "unit-hl-101", "emp-002")), http.StatusUnprocessableEntity, "VALIDATION_ERROR")
	room := created[hostedStay](t, c.do("POST", "bookings", stay("unit-hl-101", "", "2027-05-01", "2027-05-03")), "room")
	if room.HostID != nil || room.ServiceWindow.Mode != "scheduled" {
		t.Fatalf("room stay %+v", room)
	}
	refused(t, c.do("PATCH", "bookings/"+room.ID+"/preferences", map[string]any{"setups": []string{"bbq"}}), http.StatusUnprocessableEntity, "VALIDATION_ERROR")
	next := created[hostedStay](t, c.do("POST", "bookings", stay("unit-hl-101", "", "2027-05-03", "2027-05-05")), "next")
	created[hostedStay](t, c.do("PATCH", "bookings/"+next.ID+"/preferences", map[string]any{"arrivalTime": "13:00", "setups": []string{}}), "arrival time")
	refused(t, c.do("POST", "bookings/"+room.ID+"/late-checkout", map[string]any{"until": "14:00"}), http.StatusConflict, "BOOKING_INVALID_STATE")
	if r := c.do("POST", "bookings/"+room.ID+"/check-in", nil); r.status != http.StatusOK {
		t.Fatalf("check in: %d %+v", r.status, r.Error)
	}
	refused(t, c.do("POST", "bookings/"+room.ID+"/late-checkout", map[string]any{"until": "14:00"}), http.StatusConflict, "LATE_CHECKOUT_TAKEN")
	given := created[struct {
		Charge int64 `json:"charge"`
	}](t, c.do("POST", "bookings/"+room.ID+"/late-checkout", map[string]any{"until": "12:45"}), "late check-out")
	if given.Charge != 500_000 {
		t.Fatalf("room fee %d", given.Charge)
	}
	lates := func() int {
		n := 0
		for _, p := range decode[[]map[string]any](t, c.do("GET", "bookings/"+room.ID+"/folio", nil)) {
			if p["code"] == "LATE" && p["amount"] == 500_000.0 {
				n++
			}
		}
		return n
	}
	if n := lates(); n != 1 {
		t.Fatalf("the late check-out fee is on the folio %d times", n)
	}
	// Billing posts the fee from late_checkout.granted; replaying the event posts nothing more.
	var payload []byte
	ctx := context.Background()
	if err := s.db.Pool.QueryRow(ctx, `SELECT payload FROM platform.outbox WHERE event_type = $1 AND aggregate_id = $2`,
		reservation.EventLateCheckoutGranted, room.ID).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if err := s.app.Projector.Replay(ctx, billingpg.ConsumerLateCheckout, reservation.EventLateCheckoutGranted,
		[]snapshot.Record{{AggregateID: room.ID, Version: 1, Payload: payload}}); err != nil {
		t.Fatal(err)
	}
	if n := lates(); n != 1 {
		t.Fatalf("a replayed grant posted again: %d", n)
	}
}

// The guest's online check-in takes the preferences its unit kind allows, and a villa menu item
// on request is served to villas outside its hours.
func TestPreCheckInPreferencesAndVillaOnRequest(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("rama")
	b := created[hostedStay](t, c.do("POST", "bookings", stay("unit-tr-04", "", "2027-06-01", "2027-06-03")), "booking")
	guest := s.client(t)
	token := reservationdomain.CheckinToken(b.ID)
	view := decode[struct {
		UnitKind    string `json:"unitKind"`
		Preferences struct {
			Setups []string `json:"setups"`
		} `json:"preferences"`
	}](t, guest.do("GET", "checkin/"+token, nil))
	if view.UnitKind != "villa" || view.Preferences.Setups == nil {
		t.Fatalf("public view %+v", view)
	}
	form := map[string]any{"email": "", "phone": "+62 812 3456 7890", "arrivalTime": "15:00", "flight": "", "adults": 1, "children": 0,
		"travellers": []map[string]any{{"name": "Ayu Lestari", "nationality": "Indonesia", "documentType": "ktp", "documentNumber": "5103012345", "documentExpiry": "",
			"dateOfBirth": "1990-04-01", "sex": "female", "entryDate": "", "portOfEntry": "", "visaType": "none"}},
		"idPhotos": []map[string]any{{"id": "file-id", "name": "id.jpg"}}, "rulesName": "Ayu Lestari", "rulesAccepted": true,
		"preferences": map[string]any{"setups": []string{"helicopter"}}}
	refused(t, guest.do("PUT", "checkin/"+token, form), http.StatusUnprocessableEntity, "VALIDATION_ERROR")
	form["preferences"] = map[string]any{"setups": []string{"baby_cot"}, "notes": "Travelling with a baby"}
	if r := guest.do("PUT", "checkin/"+token, form); r.status != http.StatusOK {
		t.Fatalf("pre-check-in: %d %+v", r.status, r.Error)
	}
	for _, x := range decode[[]hostedStay](t, c.do("GET", "bookings", nil)) {
		if x.ID == b.ID && (x.Preferences.ArrivalTime != "15:00" || len(x.Preferences.Setups) != 1 || x.Preferences.Notes != "Travelling with a baby") {
			t.Fatalf("stay preferences %+v", x.Preferences)
		}
	}

	item := created[map[string]any](t, c.do("POST", "menu-items", map[string]any{"villaId": "vil-saka", "category": "food", "name": "Private chef dinner",
		"description": "", "photo": nil, "price": 1_500_000, "unit": "person", "availableFrom": 18 * 60, "availableTo": 21 * 60, "leadMinutes": 0,
		"active": true, "partnerId": nil, "costPrice": 0, "villaOnRequest": true}), "menu item")
	if item["villaOnRequest"] != true {
		t.Fatalf("menu item %v", item)
	}
}
