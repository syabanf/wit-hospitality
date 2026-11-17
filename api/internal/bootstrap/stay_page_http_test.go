package bootstrap_test

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

// The seeded stay page links: Tirta's TR-03 with Dewi as host, and Sekar's room SK-07.
const (
	villaStayToken = "st7c2e9b41a05d8f63e1b4c9a72d06f5e8"
	roomStayToken  = "st3f81d6c0b9e2a47d5c18e6f09b3a72d4"
)

type guestStay struct {
	State         string  `json:"state"`
	BookingCode   string  `json:"bookingCode"`
	GuestName     string  `json:"guestName"`
	UnitKind      string  `json:"unitKind"`
	HostName      *string `json:"hostName"`
	CheckOutTime  string  `json:"checkOutTime"`
	CleanAskedAt  *string `json:"cleanAskedAt"`
	ServiceWindow window  `json:"serviceWindow"`
	Preferences   struct {
		BreakfastTime string   `json:"breakfastTime"`
		Dietary       string   `json:"dietary"`
		Setups        []string `json:"setups"`
		Notes         string   `json:"notes"`
	} `json:"preferences"`
	LateCheckout *struct {
		Until  string `json:"until"`
		Charge int64  `json:"charge"`
	} `json:"lateCheckout"`
	Menu []struct {
		ID             string `json:"id"`
		Price          int64  `json:"price"`
		AvailableFrom  int    `json:"availableFrom"`
		AvailableTo    int    `json:"availableTo"`
		LeadMinutes    int    `json:"leadMinutes"`
		VillaOnRequest bool   `json:"villaOnRequest"`
	} `json:"menu"`
	Orders []struct {
		Number string `json:"number"`
		Charge int64  `json:"charge"`
	} `json:"orders"`
	Requests []struct {
		Number string `json:"number"`
		Kind   string `json:"kind"`
	} `json:"requests"`
	Folio *struct {
		Lines []struct {
			Label  string `json:"label"`
			Amount int64  `json:"amount"`
		} `json:"lines"`
		Balance int64 `json:"balance"`
	} `json:"folio"`
}

func guestOK(t *testing.T, r reply, what string) guestStay {
	t.Helper()
	if r.status != http.StatusOK {
		t.Fatalf("%s: %d %+v", what, r.status, r.Error)
	}
	for _, internal := range []string{"costPrice", "partnerId", "postedBy", "hostId", "stayToken\":\"st", "guestActions"} {
		if strings.Contains(string(r.Data), internal) {
			t.Fatalf("%s leaks %s: %s", what, internal, r.Data)
		}
	}
	return decode[guestStay](t, r)
}

// The guest's stay page without a session: the view, each of the six actions in the guest's name,
// another stay's data and staff names kept out, a token of the wrong kind refused, the rate limit
// and the link closing a day after check-out.
func TestGuestStayPage(t *testing.T) {
	t.Parallel()
	s := start(t)
	guest := s.client(t)
	staff := s.client(t)
	staff.login("kadek")

	villa := guestOK(t, guest.do("GET", "stay/"+villaStayToken, nil), "villa view")
	if villa.State != "open" || villa.UnitKind != "villa" || villa.BookingCode != "BK-1303" || villa.HostName == nil || strings.Contains(*villa.HostName, " ") || villa.Folio == nil || len(villa.Menu) == 0 {
		t.Fatalf("villa view %+v", villa)
	}
	room := guestOK(t, guest.do("GET", "stay/"+roomStayToken, nil), "room view")
	if room.UnitKind != "room" || room.HostName != nil || room.BookingCode != "BK-1294" {
		t.Fatalf("room view %+v", room)
	}
	refused(t, guest.do("GET", "stay/st00000000000000000000000000000000", nil), http.StatusNotFound, "NOT_FOUND")
	refused(t, guest.do("GET", "stay/ci-bk-1294", nil), http.StatusNotFound, "NOT_FOUND")

	// 1. Cleaning today: one stayover task, one cleaning request, then CLEAN_ALREADY_ASKED.
	cleaned := guestOK(t, guest.do("POST", "stay/"+roomStayToken+"/clean", map[string]string{"note": "Fresh towels please"}), "clean")
	if cleaned.CleanAskedAt == nil || !strings.HasPrefix(*cleaned.CleanAskedAt, "2026-11-11") {
		t.Fatalf("clean asked %+v", cleaned.CleanAskedAt)
	}
	refused(t, guest.do("POST", "stay/"+roomStayToken+"/clean", map[string]string{"note": ""}), http.StatusConflict, "CLEAN_ALREADY_ASKED")
	var cleaning int
	for range 50 {
		cleaning = 0
		for _, r := range decode[[]map[string]any](t, staff.do("GET", "service-requests", nil)) {
			if r["bookingId"] == "bk-1294" && r["kind"] == "cleaning" && r["requestedOn"] == "2026-11-11" {
				cleaning++
			}
		}
		if cleaning > 0 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if cleaning != 1 {
		t.Fatalf("cleaning requests today: %d", cleaning)
	}

	// 2. The service window by unit kind, and lifting do not disturb.
	refused(t, guest.do("PUT", "stay/"+roomStayToken+"/service-window", window{"window", "10:00", "12:00"}), http.StatusUnprocessableEntity, "VALIDATION_ERROR")
	if w := guestOK(t, guest.do("PUT", "stay/"+roomStayToken+"/service-window", window{"dnd", "", ""}), "dnd"); w.ServiceWindow.Mode != "dnd" {
		t.Fatalf("dnd %+v", w.ServiceWindow)
	}
	if w := guestOK(t, guest.do("PUT", "stay/"+roomStayToken+"/service-window", window{"scheduled", "", ""}), "lift dnd"); w.ServiceWindow.Mode != "scheduled" {
		t.Fatalf("lifted %+v", w.ServiceWindow)
	}
	refused(t, guest.do("PUT", "stay/"+villaStayToken+"/service-window", window{"scheduled", "", ""}), http.StatusUnprocessableEntity, "VALIDATION_ERROR")

	// 3. An order at menu prices and a request for the villa host.
	item := villa.Menu[0]
	for _, m := range villa.Menu {
		if m.VillaOnRequest && m.LeadMinutes <= 60 {
			item = m
			break
		}
	}
	ordered := guestOK(t, guest.do("POST", "stay/"+villaStayToken+"/orders", map[string]any{"lines": []map[string]any{{"itemId": item.ID, "quantity": 1}}, "note": "", "requestedOn": "2026-11-11", "requestedAt": 14 * 60}), "order")
	if len(ordered.Orders) != len(villa.Orders)+1 || ordered.Orders[0].Charge != item.Price {
		t.Fatalf("orders %+v", ordered.Orders)
	}
	asked := guestOK(t, guest.do("POST", "stay/"+villaStayToken+"/requests", map[string]string{"kind": "towels", "note": "Two more"}), "request")
	if len(asked.Requests) == 0 || asked.Requests[0].Kind != "towels" {
		t.Fatalf("requests %+v", asked.Requests)
	}
	for _, r := range decode[[]map[string]any](t, staff.do("GET", "service-requests", nil)) {
		if r["number"] == asked.Requests[0].Number && r["assignee"] == "" {
			t.Fatalf("the villa host takes the request: %v", r)
		}
	}
	refused(t, guest.do("POST", "stay/"+villaStayToken+"/requests", map[string]string{"kind": "cleaning", "note": ""}), http.StatusUnprocessableEntity, "VALIDATION_ERROR")

	// 4. The folio carries the late check-out fee once the guest confirms (5).
	quote := decode[struct {
		Charge int64 `json:"charge"`
	}](t, guest.do("GET", "stay/"+roomStayToken+"/late-checkout?until=14:00", nil))
	late := guestOK(t, guest.do("POST", "stay/"+roomStayToken+"/late-checkout", map[string]string{"until": "14:00"}), "late check-out")
	if late.LateCheckout == nil || late.LateCheckout.Until != "14:00" || late.LateCheckout.Charge != quote.Charge || quote.Charge <= 0 {
		t.Fatalf("late check-out %+v quote %d", late.LateCheckout, quote.Charge)
	}
	if !slicesHasLabel(late, "Late check-out until 14:00") {
		t.Fatalf("folio lines %+v", late.Folio)
	}
	refused(t, guest.do("POST", "stay/"+roomStayToken+"/late-checkout", map[string]string{"until": "15:00"}), http.StatusConflict, "BOOKING_INVALID_STATE")

	// 6. Preferences the unit kind allows.
	refused(t, guest.do("PUT", "stay/"+roomStayToken+"/preferences", map[string]any{"breakfastTime": "", "dietary": "Vegan", "setups": []string{}, "arrivalTime": "", "notes": ""}), http.StatusUnprocessableEntity, "VALIDATION_ERROR")
	prefs := guestOK(t, guest.do("PUT", "stay/"+roomStayToken+"/preferences", map[string]any{"breakfastTime": "", "dietary": "", "setups": []string{}, "arrivalTime": "", "notes": "Extra pillows"}), "preferences")
	if prefs.Preferences.Dietary != "" || prefs.Preferences.Notes != "Extra pillows" {
		t.Fatalf("room preferences %+v", prefs.Preferences)
	}

	// Staff read what the guest did on the stay and on the audit trail, in the guest's name.
	type actedStay struct {
		ID           string `json:"id"`
		GuestActions []struct {
			Kind string `json:"kind"`
			At   string `json:"at"`
		} `json:"guestActions"`
		LateCheckout *struct {
			By string `json:"by"`
		} `json:"lateCheckout"`
	}
	var booking actedStay
	for _, b := range decode[[]actedStay](t, staff.do("GET", "bookings", nil)) {
		if b.ID == "bk-1294" {
			booking = b
		}
	}
	if len(booking.GuestActions) != 5 || booking.GuestActions[0].Kind != "clean" || booking.LateCheckout == nil || booking.LateCheckout.By != "Guest" {
		t.Fatalf("guest actions %+v", booking)
	}
	owner := s.client(t)
	owner.login("rama")
	guestLines := 0
	for _, l := range decode[[]map[string]any](t, owner.do("GET", "audit", nil)) {
		if l["userName"] == "Guest" && strings.HasPrefix(l["summary"].(string), "Guest of BK-1294") {
			guestLines++
		}
	}
	if guestLines != 5 {
		t.Fatalf("guest audit lines %d", guestLines)
	}

	// Check-in makes the link; the desk asks for one only for a stay in house.
	b := created[stayLinked](t, staff.do("POST", "bookings", stay("unit-tr-04", "", "2027-05-01", "2027-05-04")), "booking")
	refused(t, staff.do("POST", "bookings/"+b.ID+"/stay-link", nil), http.StatusConflict, "BOOKING_INVALID_STATE")
	in := created[stayLinked](t, staff.do("POST", "bookings/"+b.ID+"/check-in", nil), "check in")
	if !strings.HasPrefix(in.StayToken, "st") || len(in.StayToken) != 34 {
		t.Fatalf("stay token at check-in %q", in.StayToken)
	}
	if again := created[stayLinked](t, staff.do("POST", "bookings/"+b.ID+"/stay-link", nil), "stay link"); again.StayToken != in.StayToken {
		t.Fatalf("the link stays the same: %q", again.StayToken)
	}
	guestOK(t, guest.do("GET", "stay/"+in.StayToken, nil), "new stay")
}

type stayLinked struct {
	ID        string `json:"id"`
	StayToken string `json:"stayToken"`
}

func slicesHasLabel(v guestStay, label string) bool {
	if v.Folio == nil {
		return false
	}
	for _, l := range v.Folio.Lines {
		if l.Label == label {
			return true
		}
	}
	return false
}

// Each token spends its own allowance of writes, and the link closes a day after check-out.
func TestGuestStayPageLimitsAndExpiry(t *testing.T) {
	t.Parallel()
	s := start(t)
	guest := s.client(t)
	limited := false
	for i := range 12 {
		mode := []string{"dnd", "scheduled"}[i%2]
		r := guest.do("PUT", "stay/"+roomStayToken+"/service-window", window{mode, "", ""})
		if r.status == http.StatusTooManyRequests {
			if r.Error.Code != "RATE_LIMITED" || i != 10 {
				t.Fatalf("limited at write %d: %+v", i+1, r.Error)
			}
			limited = true
			break
		}
		guestOK(t, r, "window")
	}
	if !limited {
		t.Fatal("the eleventh write in a minute goes through")
	}
	guestOK(t, guest.do("PUT", "stay/"+villaStayToken+"/service-window", window{"dnd", "", ""}), "another token")

	// Check-out is 2026-11-14: the page still opens on the 15th and closes on the 16th.
	*s.now = time.Date(2026, 11, 15, 10, 0, 0, 0, s.now.Location())
	guestOK(t, guest.do("GET", "stay/"+villaStayToken, nil), "a day after check-out")
	*s.now = time.Date(2026, 11, 16, 10, 0, 0, 0, s.now.Location())
	refused(t, guest.do("GET", "stay/"+villaStayToken, nil), http.StatusConflict, "STAY_LINK_EXPIRED")
	refused(t, guest.do("POST", "stay/"+villaStayToken+"/clean", map[string]string{"note": ""}), http.StatusConflict, "STAY_LINK_EXPIRED")
}
