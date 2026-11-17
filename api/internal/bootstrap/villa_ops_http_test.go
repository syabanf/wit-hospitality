package bootstrap_test

import (
	"net/http"
	"slices"
	"testing"
)

// Villa operations over HTTP (villa-operations-contract.md): the seed's Karang stay leaving today
// (BK-1291 on KR-01) has its pre-arrival and post-departure checks; Karang reads meters on stays
// of five nights or more; Karang and Tirta carry the pool and garden plans, Karang the fogging.

type checkJSON struct {
	ID        string     `json:"id"`
	Number    string     `json:"number"`
	BookingID string     `json:"bookingId"`
	Kind      string     `json:"kind"`
	Lines     []lineJSON `json:"lines"`
}

type lineJSON struct {
	ItemID    string `json:"itemId"`
	Condition string `json:"condition"`
	WorkOrder *struct {
		ID string `json:"id"`
	} `json:"workOrder"`
}

type postingJSON struct {
	Code   string `json:"code"`
	Amount int64  `json:"amount"`
}

type readingJSON struct {
	ID       string  `json:"id"`
	MeterID  string  `json:"meterId"`
	Value    float64 `json:"value"`
	Amount   int64   `json:"amount"`
	BilledTo *string `json:"billedTo"`
}

type upkeepOrder struct {
	ID          string `json:"id"`
	VillaID     string `json:"villaId"`
	Description string `json:"description"`
	Upkeep      *struct {
		Key       string `json:"key"`
		Checklist []struct {
			Item string `json:"item"`
		} `json:"checklist"`
		Readings *struct {
			Flags []string `json:"flags"`
		} `json:"readings"`
		Notice *struct {
			BookingCode string `json:"bookingCode"`
		} `json:"notice"`
	} `json:"upkeep"`
}

func codesOn(t *testing.T, c *client, bookingID, code string) int {
	t.Helper()
	n := 0
	for _, p := range decode[[]postingJSON](t, c.do("GET", "bookings/"+bookingID+"/folio", nil)) {
		if p.Code == code {
			n++
		}
	}
	return n
}

func TestVillaInventoryChecksOverHTTP(t *testing.T) {
	s := start(t)
	c := s.client(t)
	c.login("kadek")
	checks := decode[[]checkJSON](t, c.do("GET", "inventory-checks", nil))
	i := slices.IndexFunc(checks, func(x checkJSON) bool { return x.Kind == "post_departure" })
	if len(checks) != 2 || i < 0 {
		t.Fatalf("checks %+v", checks)
	}
	post := checks[i]
	if codesOn(t, c, post.BookingID, "DMG") != 1 || codesOn(t, c, post.BookingID, "UTIL") != 1 {
		t.Fatal("the seeded damage and electricity are not on the folio")
	}
	towel := post.Lines[slices.IndexFunc(post.Lines, func(l lineJSON) bool {
		return l.Condition == "missing"
	})]
	path := "inventory-checks/" + post.ID + "/lines/" + towel.ItemID
	field(t, c.do("POST", path+"/charge", map[string]any{"quantity": 1, "reason": "x"}), "reason", "Say why the guest pays for it.")
	if r := c.do("POST", path+"/charge", map[string]any{"quantity": 1, "reason": "Not returned"}); r.status != http.StatusOK {
		t.Fatalf("charge: %d %+v", r.status, r.Error)
	}
	refused(t, c.do("POST", path+"/charge", map[string]any{"quantity": 1, "reason": "Not returned"}), http.StatusConflict, "CHECK_CHARGED")
	if n := codesOn(t, c, post.BookingID, "DMG"); n != 2 {
		t.Fatalf("%d DMG postings after the charge", n)
	}
	raised := decode[checkJSON](t, c.do("POST", path+"/work-order", map[string]any{}))
	line := raised.Lines[slices.IndexFunc(raised.Lines, func(l lineJSON) bool {
		return l.ItemID == towel.ItemID
	})]
	if line.WorkOrder == nil || c.do("GET", "work-orders", nil).status != http.StatusOK {
		t.Fatalf("work order %+v", line)
	}
	refused(t, c.do("POST", "unit-items/copy", map[string]string{"fromUnitId": "unit-kr-01", "toUnitId": "unit-kr-02"}), http.StatusConflict, "INVENTORY_COPY_NOTHING")
	w := s.client(t)
	w.login("wayan")
	refused(t, w.do("POST", path+"/adjust", map[string]any{}), http.StatusForbidden, "FORBIDDEN")
}

func TestMeterReadingsBillTheLongStayOverHTTP(t *testing.T) {
	s := start(t)
	c := s.client(t)
	c.login("kadek")
	readings := decode[[]readingJSON](t, c.do("GET", "meter-readings", nil))
	var last float64
	for _, r := range readings {
		if r.MeterID == "mtr-3" {
			last = r.Value
		}
	}
	refused(t, c.do("POST", "meter-readings", map[string]any{"meterId": "mtr-3", "on": "2026-11-11", "value": last - 1, "purpose": "monthly", "replacement": false}), http.StatusConflict, "READING_BELOW_PREVIOUS")
	// BK-1296 stays seven nights on KR-03: Karang reads meters from five.
	in := decode[readingJSON](t, c.do("POST", "meter-readings", map[string]any{"meterId": "mtr-3", "on": "2026-11-11", "value": last + 12, "purpose": "check_in", "bookingId": "bk-1296", "replacement": false}))
	if in.BilledTo != nil {
		t.Fatalf("check-in billed %+v", in)
	}
	out := decode[readingJSON](t, c.do("POST", "meter-readings", map[string]any{"meterId": "mtr-3", "on": "2026-11-11", "value": last + 32, "purpose": "check_out", "bookingId": "bk-1296", "replacement": false}))
	if out.BilledTo == nil || *out.BilledTo != "guest" || out.Amount != 34_000 {
		t.Fatalf("check-out %+v", out)
	}
	if n := codesOn(t, c, "bk-1296", "UTIL"); n != 1 {
		t.Fatalf("%d UTIL postings on BK-1296", n)
	}
	field(t, c.do("PUT", "utility-settings/vil-karang", map[string]any{"longStayNights": 0}), "longStayNights", "A whole number of nights from 1 to 365.")
	w := s.client(t)
	w.login("wayan")
	refused(t, w.do("PUT", "utility-settings/vil-saka", map[string]any{"longStayNights": 14}), http.StatusForbidden, "FORBIDDEN")
}

func TestUpkeepTemplatesOverHTTP(t *testing.T) {
	s := start(t)
	c := s.client(t)
	c.login("kadek")
	refused(t, c.do("POST", "preventive-plans/templates", map[string]any{"villaId": "vil-karang", "unitId": nil, "template": "pool", "startOn": "2026-11-11"}), http.StatusConflict, "UPKEEP_APPLIED")
	if r := c.do("POST", "preventive-plans/templates", map[string]any{"villaId": "vil-lumbung", "unitId": nil, "template": "garden", "startOn": "2026-11-20"}); r.status != http.StatusCreated {
		t.Fatalf("garden on Lumbung: %d %+v", r.status, r.Error)
	}
	created := decode[[]upkeepOrder](t, c.do("POST", "preventive-plans/generate", map[string]any{"horizonDays": 0}))
	var fog, pool *upkeepOrder
	for i := range created {
		w := &created[i]
		if w.VillaID != "vil-karang" || w.Upkeep == nil {
			continue
		}
		switch w.Upkeep.Key {
		case "fogging_monthly":
			fog = w
		case "pool_daily":
			pool = w
		}
	}
	if fog == nil || fog.Upkeep.Notice == nil || pool == nil {
		t.Fatalf("generated %+v", created)
	}
	c.do("POST", "work-orders/"+pool.ID+"/status", map[string]string{"status": "in_progress"})
	refused(t, c.do("POST", "work-orders/"+pool.ID+"/status", map[string]string{"status": "done"}), http.StatusConflict, "READINGS_REQUIRED")
	ticks := make([]bool, len(pool.Upkeep.Checklist))
	saved := decode[upkeepOrder](t, c.do("PUT", "work-orders/"+pool.ID+"/upkeep", map[string]any{"checklist": ticks, "readings": map[string]float64{"ph": 7.0, "chlorine": 2}, "noticeSent": false}))
	if saved.Upkeep.Readings == nil || !slices.Equal(saved.Upkeep.Readings.Flags, []string{"pH low"}) {
		t.Fatalf("readings %+v", saved.Upkeep)
	}
	if r := c.do("POST", "work-orders/"+pool.ID+"/status", map[string]string{"status": "done"}); r.status != http.StatusOK {
		t.Fatalf("done: %d %+v", r.status, r.Error)
	}
	field(t, c.do("PUT", "work-orders/"+pool.ID+"/upkeep", map[string]any{"checklist": []bool{}, "readings": nil, "noticeSent": false}), "checklist", "Tick the checklist as listed.")
}
