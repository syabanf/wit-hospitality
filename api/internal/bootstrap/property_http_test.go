package bootstrap_test

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

// pngBytes is enough of a PNG for the upload to sniff and keep as image/png.
var pngBytes = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89")

func (s server) public(t *testing.T, path string) (int, string, []byte) {
	t.Helper()
	res, err := http.Get(s.url + path)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res.StatusCode, res.Header.Get("Content-Type"), body
}

type villaJSON struct {
	ID                 string           `json:"id"`
	LocationID         string           `json:"locationId"`
	Code               string           `json:"code"`
	Name               string           `json:"name"`
	CheckInTime        string           `json:"checkInTime"`
	CancellationPolicy string           `json:"cancellationPolicy"`
	BankAccountNo      string           `json:"bankAccountNo"`
	Photos             []map[string]any `json:"photos"`
}

// A villa takes its profile and photos in one PATCH; the public site then serves the photo
// without a session, and nothing else.
func TestVillaProfilePhotosAndPublicPhoto(t *testing.T) {
	t.Setenv("FILES_DIR", t.TempDir())
	s := start(t)
	c := s.client(t)
	c.login("rama")
	photo := decode[struct {
		ID string `json:"id"`
	}](t, c.upload("pool.png", "image/png", pngBytes))
	pdf := decode[struct {
		ID string `json:"id"`
	}](t, c.upload("menu.pdf", "application/pdf", []byte("%PDF-1.4")))

	var saka villaJSON
	for _, v := range decode[[]villaJSON](t, c.do("GET", "villas", nil)) {
		if v.ID == "vil-saka" {
			saka = v
		}
	}
	if saka.CheckInTime != "14:00" || saka.CancellationPolicy != "moderate" || len(saka.Photos) != 0 {
		t.Fatalf("seeded villa %+v", saka)
	}
	form := map[string]any{
		"locationId": saka.LocationID, "code": saka.Code, "name": saka.Name, "description": "", "facilities": []string{"pool"},
		"address": "Jl. Pantai Batu Bolong 12", "lat": -8.65, "lng": 115.13, "phone": "+62 361 123", "email": "stay@saka.id",
		"checkInTime": "15:00", "checkOutTime": "11:00", "licenseNo": "NIB 123", "bankName": "BCA", "bankAccountNo": "1234567890",
		"bankAccountName": "PT Saka", "houseRules": "No parties.", "cancellationPolicy": "strict", "depositKind": "fixed", "depositValue": 1_000_000,
		"photos": []map[string]string{{"fileId": photo.ID, "caption": "Pool"}},
	}
	got := decode[villaJSON](t, c.do("PATCH", "villas/vil-saka", form))
	if got.CheckInTime != "15:00" || got.BankAccountNo != "1234567890" || len(got.Photos) != 1 {
		t.Fatalf("patched %+v", got)
	}

	form["photos"] = []map[string]string{{"fileId": pdf.ID, "caption": ""}}
	refused(t, c.do("PATCH", "villas/vil-saka", form), http.StatusConflict, "PHOTO_NOT_IMAGE")
	form["photos"] = []map[string]string{{"fileId": "file-nope", "caption": ""}}
	refused(t, c.do("PATCH", "villas/vil-saka", form), http.StatusConflict, "PHOTO_UNKNOWN")

	status, kind, body := s.public(t, "site/photos/"+photo.ID)
	if status != http.StatusOK || kind != "image/png" || string(body) != string(pngBytes) {
		t.Fatalf("public photo: %d %s", status, kind)
	}
	if status, _, _ := s.public(t, "site/photos/"+pdf.ID); status != http.StatusNotFound {
		t.Fatalf("an upload that is no photo: %d", status)
	}

	// The public site shows the profile without contact, bank or licence details.
	inv := decode[struct {
		Villas []map[string]json.RawMessage `json:"villas"`
	}](t, s.client(t).do("GET", "public/site/inventory", nil))
	for _, v := range inv.Villas {
		if string(v["id"]) != `"vil-saka"` {
			continue
		}
		if string(v["checkInTime"]) != `"15:00"` || v["bankAccountNo"] != nil || v["licenseNo"] != nil || v["phone"] != nil || v["email"] != nil {
			t.Fatalf("public villa %v", v)
		}
	}
}

type unitJSON struct {
	ID           string  `json:"id"`
	VillaID      string  `json:"villaId"`
	GroupID      *string `json:"groupId"`
	Code         string  `json:"code"`
	Name         string  `json:"name"`
	Bedrooms     int     `json:"bedrooms"`
	NightlyRate  int64   `json:"nightlyRate"`
	Status       string  `json:"status"`
	MaxAdults    int     `json:"maxAdults"`
	MaxChildren  int     `json:"maxChildren"`
	StatusReason string  `json:"statusReason"`
	StatusUntil  *string `json:"statusUntil"`
}

// A manager takes a unit out of service with a reason; the history lists the change.
func TestUnitStatusChangeAndHistory(t *testing.T) {
	s := start(t)
	c := s.client(t)
	c.login("kadek")
	var kr unitJSON
	for _, u := range decode[[]unitJSON](t, c.do("GET", "units", nil)) {
		if u.ID == "unit-kr-03" {
			kr = u
		}
	}
	if kr.MaxAdults != kr.Bedrooms*2 || kr.MaxChildren != kr.Bedrooms {
		t.Fatalf("seeded capacity %+v", kr)
	}
	form := map[string]any{
		"villaId": kr.VillaID, "groupId": kr.GroupID, "code": kr.Code, "name": kr.Name, "bedrooms": kr.Bedrooms, "nightlyRate": kr.NightlyRate,
		"status": "maintenance", "amenities": []string{}, "maxAdults": kr.MaxAdults, "maxChildren": kr.MaxChildren, "beds": []map[string]any{{"type": "king", "count": 2}},
		"sizeSqm": 85, "view": "ocean", "extraBeds": 1, "extraBedRate": 300_000,
	}
	refused(t, c.do("PATCH", "units/unit-kr-03", form), http.StatusUnprocessableEntity, "VALIDATION_ERROR")
	form["statusReason"], form["statusUntil"] = "Roof repair", "2026-11-20"
	u := decode[unitJSON](t, c.do("PATCH", "units/unit-kr-03", form))
	if u.Status != "maintenance" || u.StatusReason != "Roof repair" || u.StatusUntil == nil || *u.StatusUntil != "2026-11-20" {
		t.Fatalf("patched %+v", u)
	}
	history := decode[[]struct {
		UnitID string  `json:"unitId"`
		From   string  `json:"from"`
		To     string  `json:"to"`
		Reason string  `json:"reason"`
		Until  *string `json:"until"`
		By     string  `json:"by"`
		At     string  `json:"at"`
	}](t, c.do("GET", "unit-status-history?unitId=unit-kr-03", nil))
	if len(history) != 1 || history[0].From != "active" || history[0].To != "maintenance" || history[0].Reason != "Roof repair" ||
		history[0].By != "Kadek Ariani" || history[0].At == "" {
		t.Fatalf("history %+v", history)
	}
}
