package domain_test

import (
	"reflect"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/channel/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func fields(t *testing.T, err error) map[string]string {
	t.Helper()
	if err == nil {
		return map[string]string{}
	}
	e, ok := errs.As(err)
	if !ok || e.Code != errs.CodeValidation {
		t.Fatalf("want VALIDATION_ERROR, got %v", err)
	}
	return errs.Fields(e.Fields).Map()
}

func ptr[T any](v T) *T { return &v }

func TestValidateAccount(t *testing.T) {
	got := fields(t, domain.ValidateAccount(domain.AccountInput{Name: " N ", Email: "host", Status: "active"}, false))
	want := map[string]string{"name": "Enter the host account name.", "email": "Enter the host login email."}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	got = fields(t, domain.ValidateAccount(domain.AccountInput{Name: " Saka Stays ", Email: "host@saka.id", Status: "active"}, true))
	if got["name"] != "Saka Stays already exists." {
		t.Fatalf("duplicate name: %v", got)
	}
	if err := domain.ValidateAccount(domain.AccountInput{Name: "Nusa Hosts", Email: "host@nusa.id", Status: "paused"}, false); err != nil {
		t.Fatal(err)
	}
	if got := fields(t, domain.ValidateAccount(domain.AccountInput{Name: "Nusa Hosts", Email: "host@nusa.id", Status: "gone"}, false)); got["status"] == "" {
		t.Fatalf("status: %v", got)
	}
}

func TestNewAccountSlotStopsAtFive(t *testing.T) {
	in := domain.AccountInput{Name: "  Nusa Hosts ", Email: "host@nusa.id", Status: "active"}
	if a := domain.NewAccount("acc-x", in, 0); a.Slot != 2 || a.Name != "Nusa Hosts" {
		t.Fatalf("first account: %+v", a)
	}
	if a := domain.NewAccount("acc-x", in, 7); a.Slot != 5 {
		t.Fatalf("slot after many accounts: %d", a.Slot)
	}
}

// From services.test.ts: a second listing on the same unit is refused.
func TestValidateListing(t *testing.T) {
	got := fields(t, domain.ValidateListing(domain.ListingInput{Title: "Abc", AirbnbID: "12345", Status: "active"}, false, false))
	want := map[string]string{
		"accountId": "Pick the host account.", "unitId": "Pick the unit.",
		"title": "Enter the listing title as Airbnb shows it.", "airbnbId": "The Airbnb listing id is 6 to 12 digits.",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	in := domain.ListingInput{AccountID: "acc-saka-stays", UnitID: "unit-sk-01", Title: "Duplicate", AirbnbID: "123456789", Status: "active"}
	got = fields(t, domain.ValidateListing(in, true, true))
	if got["unitId"] != "That unit already has a listing." || got["airbnbId"] != "That listing id is already on file." {
		t.Fatalf("taken: %v", got)
	}
	if err := domain.ValidateListing(in, false, false); err != nil {
		t.Fatal(err)
	}
	if e, _ := errs.As(domain.ValidateListing(domain.ListingInput{}, false, false)); e.Fields[0].Field != "accountId" {
		t.Fatalf("first field: %v", e.Fields)
	}
}

func TestListingIDAndTrim(t *testing.T) {
	if got := domain.ListingID("KR-03"); got != "lst-kr-03" {
		t.Fatal(got)
	}
	l := domain.NewListing("lst-kr-03", domain.ListingInput{Title: "  Karang 3  ", Status: "active"})
	if l.Title != "Karang 3" || l.DateRates == nil || len(l.DateRates) != 0 {
		t.Fatalf("%+v", l)
	}
}

func TestValidatePrice(t *testing.T) {
	got := fields(t, domain.ValidatePrice(domain.PriceInput{BaseRate: 0}))
	if got["baseRate"] != "Enter the base price in whole rupiah." {
		t.Fatalf("zero base: %v", got)
	}
	if got := fields(t, domain.ValidatePrice(domain.PriceInput{BaseRate: 1_500_000.5})); got["baseRate"] == "" {
		t.Fatal("a fraction of a rupiah passed")
	}
	got = fields(t, domain.ValidatePrice(domain.PriceInput{BaseRate: 1_000_000, DateRates: map[string]*float64{"2026-11-20": ptr(-1.0)}}))
	if got["dateRates"] != "Enter the price for 2026-11-20 in whole rupiah." {
		t.Fatalf("negative night: %v", got)
	}
	got = fields(t, domain.ValidatePrice(domain.PriceInput{BaseRate: 1_000_000, DateRates: map[string]*float64{"20-11-2026": ptr(1.0)}}))
	if got["dateRates"] != "Pick the night to price." {
		t.Fatalf("bad date: %v", got)
	}
	ok := domain.PriceInput{BaseRate: 1_700_000, DateRates: map[string]*float64{"2026-11-26": ptr(2_500_000.0), "2026-11-27": nil}}
	if err := domain.ValidatePrice(ok); err != nil {
		t.Fatal(err)
	}
}

// From the mock's setListingPrices: a null night or one at the new base rate falls back to it.
func TestApplyPrices(t *testing.T) {
	l := domain.Listing{DateRates: map[string]int64{"2026-11-20": 1_200_000, "2026-11-21": 1_300_000, "2026-11-22": 1_400_000}}
	base := l.ApplyPrices(domain.PriceInput{BaseRate: 1_300_000, DateRates: map[string]*float64{
		"2026-11-20": nil, "2026-11-21": ptr(1_300_000.0), "2026-11-26": ptr(2_500_000.0),
	}})
	want := map[string]int64{"2026-11-22": 1_400_000, "2026-11-26": 2_500_000}
	if base != 1_300_000 || !reflect.DeepEqual(l.DateRates, want) {
		t.Fatalf("base %d, rates %v", base, l.DateRates)
	}
}

// From pricing.test.ts: each night from the listing, falling back to the base rate.
func TestNights(t *testing.T) {
	got := domain.Nights(1_000_000, map[string]int64{"2026-11-20": 1_200_000}, "2026-11-19", "2026-11-22")
	want := []domain.Night{{"2026-11-19", 1_000_000, false}, {"2026-11-20", 1_200_000, true}, {"2026-11-21", 1_000_000, false}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	if got := domain.Nights(1_000_000, nil, "2026-11-19", "2026-11-19"); len(got) != 0 {
		t.Fatalf("no nights: %v", got)
	}
}

func enquiry() domain.EnquiryInput {
	return domain.EnquiryInput{
		Name: "Mia Hartono", Email: "mia@example.com", WhatsApp: "+62 812 0000 1111", Country: "ID",
		CheckIn: "2026-11-20", CheckOut: "2026-11-23", Guests: 2, VillaID: "vil-saka", GroupID: ptr("grp-saka-standard"),
	}
}

// From site.test.ts: missing contact, a room type of another villa, a past check-in, owner notes.
func TestValidateEnquiry(t *testing.T) {
	const today = "2026-11-11"
	if err := domain.ValidateEnquiry(enquiry(), today, "vil-saka"); err != nil {
		t.Fatal(err)
	}
	in := enquiry()
	in.Email, in.WhatsApp = "mia", "12"
	got := fields(t, domain.ValidateEnquiry(in, today, "vil-saka"))
	if got["email"] != "Enter an email address we can reply to." || got["whatsapp"] != "Enter a WhatsApp number with the country code." {
		t.Fatalf("contact: %v", got)
	}
	if got := fields(t, domain.ValidateEnquiry(enquiry(), today, "vil-tirta")); got["groupId"] != "Pick a room type of this villa." {
		t.Fatalf("room type of another villa: %v", got)
	}
	in = enquiry()
	in.CheckIn, in.CheckOut = "2026-11-09", "2026-11-11"
	if got := fields(t, domain.ValidateEnquiry(in, today, "vil-saka")); got["checkIn"] != "Pick a check-in date from today on." {
		t.Fatalf("past check-in: %v", got)
	}
	in = enquiry()
	in.CheckOut = in.CheckIn
	if got := fields(t, domain.ValidateEnquiry(in, today, "vil-saka")); got["checkOut"] != "Check-out must be after check-in." {
		t.Fatalf("no nights: %v", got)
	}
	in = enquiry()
	in.Guests, in.Country, in.VillaID = 17, "XX", ""
	got = fields(t, domain.ValidateEnquiry(in, today, ""))
	if got["guests"] != "Enter from 1 to 16 guests." || got["country"] != "Pick your country." || got["villaId"] != "Pick a villa." || got["groupId"] != "" {
		t.Fatalf("party, country and villa: %v", got)
	}

	owner := domain.EnquiryInput{Name: "Ketut", Email: "ketut@example.com", WhatsApp: "+62 811 222 333", Country: "ID", Topic: domain.TopicOwner, Note: "Hi"}
	if got := fields(t, domain.ValidateEnquiry(owner, today, "")); got["note"] != "Tell us where the villa is and how many rooms it has." || len(got) != 1 {
		t.Fatalf("owner note: %v", got)
	}
	owner.Note = "Three-bedroom villa in Sanur, self-run today."
	if err := domain.ValidateEnquiry(owner, today, ""); err != nil {
		t.Fatal(err)
	}
	e := domain.NewEnquiry(5, domain.EnquiryInput{Name: owner.Name, Topic: domain.TopicOwner, VillaID: "vil-saka", CheckIn: "2026-11-20", Guests: 3}, today, "2026-11-11T10:00:00")
	if e.Number != "ENQ-0005" || e.ID != "enq-5" || e.VillaID != "" || e.CheckIn != "" || e.Guests != 0 || e.Status != domain.EnquiryNew {
		t.Fatalf("owner enquiry keeps no stay: %+v", e)
	}
}

// From site.test.ts: a reason to close, a converted enquiry stays, a closed one is picked up again.
func TestEnquiryTransitions(t *testing.T) {
	if got := fields(t, domain.ValidateStatusChange(domain.EnquiryClosed, " ")); got["note"] != "Say why it is closed." {
		t.Fatalf("close without a reason: %v", got)
	}
	if err := domain.ValidateStatusChange(domain.EnquiryConverted, ""); !errs.HasCode(err, errs.CodeValidation) {
		t.Fatalf("converting goes through the booking: %v", err)
	}
	e := domain.Enquiry{Number: "ENQ-0001", Status: domain.EnquiryNew}
	if err := e.Move(domain.EnquiryContacted, " Called on WhatsApp ", "Dian Permata"); err != nil {
		t.Fatal(err)
	}
	if e.Status != domain.EnquiryContacted || e.StatusNote != "Called on WhatsApp" || *e.HandledBy != "Dian Permata" {
		t.Fatalf("%+v", e)
	}
	if err := e.Move(domain.EnquiryConverted, "Booked as BK-2101", "Dian Permata"); err != nil {
		t.Fatal(err)
	}
	err := e.Move(domain.EnquiryConverted, "", "Dian Permata")
	if e2, _ := errs.As(err); e2 == nil || e2.Code != "ENQUIRY_INVALID_STATE" || e2.Message != "ENQ-0001 is Converted and cannot move to Converted." {
		t.Fatalf("converted is the end: %v", err)
	}
	closed := domain.Enquiry{Number: "ENQ-0004", Status: domain.EnquiryClosed}
	if err := closed.Move(domain.EnquiryContacted, "Asked again", "Dian Permata"); err != nil {
		t.Fatal(err)
	}
}
