package bootstrap_test

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

type listing struct {
	ID        string           `json:"id"`
	UnitID    string           `json:"unitId"`
	Status    string           `json:"status"`
	DateRates map[string]int64 `json:"dateRates"`
}

type pricedUnit struct {
	ID          string `json:"id"`
	NightlyRate int64  `json:"nightlyRate"`
}

func findListing(t *testing.T, list []listing, id string) listing {
	t.Helper()
	for _, l := range list {
		if l.ID == id {
			return l
		}
	}
	t.Fatalf("no listing %s", id)
	return listing{}
}

// A listing price edit moves the listing's nights and, through property's policy, the unit's
// nightly rate; the next reads see both.
func TestListingPriceEditMovesTheUnitBaseRate(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("putu")
	listings := decode[[]listing](t, c.do("GET", "airbnb-listings", nil))
	if len(listings) != 4 {
		t.Fatalf("Putu sees the four Tirta listings, got %d", len(listings))
	}
	r := c.do("PUT", "airbnb-listings/lst-tr-04/prices", map[string]any{"baseRate": 1_700_000, "dateRates": map[string]any{"2026-11-26": 2_500_000, "2026-11-27": nil}})
	if r.status != http.StatusOK || decode[listing](t, r).DateRates["2026-11-26"] != 2_500_000 {
		t.Fatalf("price edit: %d %+v %s", r.status, r.Error, r.Data)
	}
	if l := findListing(t, decode[[]listing](t, c.do("GET", "airbnb-listings", nil)), "lst-tr-04"); l.DateRates["2026-11-26"] != 2_500_000 {
		t.Fatalf("listing after the edit: %v", l.DateRates["2026-11-26"])
	}
	for _, u := range decode[[]pricedUnit](t, c.do("GET", "units", nil)) {
		if u.ID == "unit-tr-04" && u.NightlyRate != 1_700_000 {
			t.Fatalf("the unit's base rate follows the listing: %d", u.NightlyRate)
		}
	}
	owner := s.client(t)
	owner.login("rama")
	trail := decode[[]map[string]any](t, owner.do("GET", "audit", nil))
	if trail[1]["summary"] != "Priced TR-04: base 1700000, 2 nights changed" || trail[1]["userId"] != "usr-putu" {
		t.Fatalf("audit line before Rama's sign-in: %v", trail[1])
	}

	bad := c.do("PUT", "airbnb-listings/lst-tr-04/prices", map[string]any{"baseRate": 0, "dateRates": map[string]any{}})
	if bad.status != http.StatusUnprocessableEntity || bad.Error.Message != "Enter the base price in whole rupiah." {
		t.Fatalf("zero base: %d %+v", bad.status, bad.Error)
	}
	out := c.do("PUT", "airbnb-listings/lst-sk-01/prices", map[string]any{"baseRate": 1_000_000, "dateRates": map[string]any{}})
	if out.status != http.StatusForbidden || out.Error.Message != "SK-01 is outside the villas you work with." {
		t.Fatalf("a listing outside the scope: %d %+v", out.status, out.Error)
	}
	paused := c.do("PATCH", "airbnb-listings/lst-tr-04", map[string]string{"status": "paused"})
	if paused.status != http.StatusOK || decode[listing](t, paused).Status != "paused" {
		t.Fatalf("pause: %d %+v", paused.status, paused.Error)
	}
}

func TestStaffCannotEditListingPrices(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("wayan")
	if l := decode[[]listing](t, c.do("GET", "airbnb-listings", nil)); len(l) != 8 {
		t.Fatalf("Wayan reads the Saka listings, got %d", len(l))
	}
	r := c.do("PUT", "airbnb-listings/lst-sk-01/prices", map[string]any{"baseRate": 1_000_000, "dateRates": map[string]any{}})
	if r.status != http.StatusForbidden || r.Error.Code != "FORBIDDEN" || r.Error.Message != "Staff cannot edit in Airbnb." {
		t.Fatalf("staff editing prices: %d %+v", r.status, r.Error)
	}
	if r := c.do("POST", "airbnb-accounts", map[string]string{"name": "Wayan Hosts", "email": "w@x.id", "status": "active"}); r.status != http.StatusForbidden {
		t.Fatalf("staff adding an account: %d", r.status)
	}
}

func TestPublicSiteAndEnquiries(t *testing.T) {
	t.Parallel()
	s := start(t)
	guest := s.client(t)
	inv := decode[map[string]json.RawMessage](t, guest.do("GET", "public/site/inventory", nil))
	var units []pricedUnit
	_ = json.Unmarshal(inv["units"], &units)
	if len(units) != 20 || string(inv["contact"]) != `{"whatsapp":null,"email":null}` {
		t.Fatalf("inventory without a session: %d units, contact %s", len(units), inv["contact"])
	}
	if r := guest.do("GET", "public/site/holds?from=2026-11-01&to=2027-02-01", nil); r.status != http.StatusOK {
		t.Fatalf("holds: %d %+v", r.status, r.Error)
	}
	r := guest.do("POST", "public/enquiries", map[string]any{
		"name": "Mia Hartono", "email": "mia@example.com", "whatsapp": "+62 812 0000 1111", "country": "ID",
		"checkIn": "2026-11-20", "checkOut": "2026-11-23", "guests": 2, "villaId": "vil-saka", "groupId": nil, "note": "",
	})
	if r.status != http.StatusCreated || decode[map[string]string](t, r)["number"] != "ENQ-0005" {
		t.Fatalf("enquire: %d %+v %s", r.status, r.Error, r.Data)
	}
	staff := s.client(t)
	staff.login("kadek")
	list := decode[[]map[string]any](t, staff.do("GET", "enquiries", nil))
	if len(list) != 5 || list[0]["number"] != "ENQ-0005" {
		t.Fatalf("the new enquiry tops the list: %d", len(list))
	}
	moved := staff.do("POST", "enquiries/enq-5/status", map[string]string{"status": "contacted", "note": "Called on WhatsApp"})
	if moved.status != http.StatusOK || decode[map[string]any](t, moved)["status"] != "contacted" {
		t.Fatalf("contacted: %d %+v", moved.status, moved.Error)
	}
}

func TestInternalPriceLookup(t *testing.T) {
	t.Parallel()
	s := start(t)
	base := s.url[:len(s.url)-len("api/v1/")] + "internal/v1/channel/"
	get := func(path, token string) (int, map[string]json.RawMessage) {
		req, _ := http.NewRequest("GET", base+path, nil)
		req.Header.Set("X-Internal-Token", token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		var body map[string]json.RawMessage
		_ = json.Unmarshal(raw, &body)
		return res.StatusCode, body
	}
	if status, _ := get("prices?unitId=unit-tr-04&from=2026-11-18&to=2026-11-20", "wrong"); status != http.StatusForbidden {
		t.Fatalf("without the internal token: %d", status)
	}
	status, body := get("prices?unitId=unit-tr-04&from=2026-11-18&to=2026-11-20", "internal")
	var prices struct {
		Listed bool `json:"listed"`
		Nights []struct {
			Date string `json:"date"`
			Rate int64  `json:"rate"`
		} `json:"nights"`
	}
	if err := json.Unmarshal(body["data"], &prices); status != http.StatusOK || err != nil || !prices.Listed || len(prices.Nights) != 2 || prices.Nights[0].Rate == 0 {
		t.Fatalf("prices: %d %s", status, body["data"])
	}
	if status, body := get("listings/active?unitId=unit-sk-08", "internal"); status != http.StatusOK || string(body["data"]) != "null" {
		t.Fatalf("a paused listing is not active: %d %s", status, body["data"])
	}
}
