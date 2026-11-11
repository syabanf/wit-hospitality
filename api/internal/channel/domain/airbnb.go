// Package domain holds the channel context's rules, ported from src/domain/airbnb.ts,
// src/domain/pricing.ts (the listing price list), src/domain/enquiry.ts and the Airbnb and site
// adapters in src/infrastructure/mock. Validators return field errors in the TypeScript order with
// the same wording; refusals carry the same codes.
package domain

import (
	"math"
	"regexp"
	"slices"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Account and listing statuses.
const (
	StatusActive = "active"
	StatusPaused = "paused"
)

// Statuses is AirbnbAccountStatus and ListingStatus: both read active or paused.
var Statuses = []string{StatusActive, StatusPaused}

// Account is an Airbnb host account. Slot is its colour in the revenue by source chart; direct
// bookings take slot 1.
type Account struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Email   string `json:"email"`
	Status  string `json:"status"`
	Slot    int    `json:"slot"`
	Version int64  `json:"-"`
}

// AccountInput is the host account form.
type AccountInput struct {
	Name   string `json:"name"`
	Email  string `json:"email"`
	Status string `json:"status"`
}

// Listing is the one Airbnb listing a unit has, under one of the accounts. DateRates holds the
// nights priced away from the unit's base rate.
type Listing struct {
	ID        string           `json:"id"`
	AccountID string           `json:"accountId"`
	UnitID    string           `json:"unitId"`
	Title     string           `json:"title"`
	AirbnbID  string           `json:"airbnbId"`
	Status    string           `json:"status"`
	DateRates map[string]int64 `json:"dateRates"`
	Version   int64            `json:"-"`
}

// ListingInput is the listing form.
type ListingInput struct {
	AccountID string `json:"accountId"`
	UnitID    string `json:"unitId"`
	Title     string `json:"title"`
	AirbnbID  string `json:"airbnbId"`
	Status    string `json:"status"`
}

// PriceInput is a price edit: the base rate (shared with the unit) and nights to set, or null to
// fall back to the base rate. Numbers stay unchecked until ValidatePrice.
type PriceInput struct {
	BaseRate  float64             `json:"baseRate"`
	DateRates map[string]*float64 `json:"dateRates"`
}

var (
	emailRe    = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)
	airbnbIDRe = regexp.MustCompile(`^\d{6,12}$`)
	isoDateRe  = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

func wholePositive(v float64) bool { return v > 0 && v == math.Trunc(v) && v <= math.MaxInt64 }

func validStatus(f *errs.Fields, status string) {
	if !slices.Contains(Statuses, status) {
		f.Add("status", "Pick active or paused.")
	}
}

// ValidateAccount is validateAirbnbAccount; nameTaken reports another account with the trimmed
// name, ignoring case.
func ValidateAccount(in AccountInput, nameTaken bool) error {
	var f errs.Fields
	name := strings.TrimSpace(in.Name)
	if utf8.RuneCountInString(name) < 2 {
		f.Add("name", "Enter the host account name.")
	} else if nameTaken {
		f.Add("name", name+" already exists.")
	}
	if !emailRe.MatchString(in.Email) {
		f.Add("email", "Enter the host login email.")
	}
	validStatus(&f, in.Status)
	return f.Err()
}

// NewAccount builds an account. The mock gives slot 2 to the first account and stops at 5.
func NewAccount(id string, in AccountInput, accounts int) Account {
	return Account{ID: id, Name: strings.TrimSpace(in.Name), Email: in.Email, Status: in.Status, Slot: min(5, accounts+2)}
}

// Apply copies the form onto the account.
func (a *Account) Apply(in AccountInput) {
	a.Name, a.Email, a.Status = strings.TrimSpace(in.Name), in.Email, in.Status
}

// ValidateListing is validateListing; unitTaken and airbnbIDTaken report another listing with the
// unit or the Airbnb id.
func ValidateListing(in ListingInput, unitTaken, airbnbIDTaken bool) error {
	var f errs.Fields
	if in.AccountID == "" {
		f.Add("accountId", "Pick the host account.")
	}
	if in.UnitID == "" {
		f.Add("unitId", "Pick the unit.")
	} else if unitTaken {
		f.Add("unitId", "That unit already has a listing.")
	}
	if utf8.RuneCountInString(strings.TrimSpace(in.Title)) < 4 {
		f.Add("title", "Enter the listing title as Airbnb shows it.")
	}
	if !airbnbIDRe.MatchString(in.AirbnbID) {
		f.Add("airbnbId", "The Airbnb listing id is 6 to 12 digits.")
	} else if airbnbIDTaken {
		f.Add("airbnbId", "That listing id is already on file.")
	}
	validStatus(&f, in.Status)
	return f.Err()
}

// ListingID is the mock's id for a unit's listing: lst- and the unit code in lower case.
func ListingID(unitCode string) string { return "lst-" + strings.ToLower(unitCode) }

// NewListing builds a listing with no date prices.
func NewListing(id string, in ListingInput) Listing {
	return Listing{ID: id, AccountID: in.AccountID, UnitID: in.UnitID, Title: strings.TrimSpace(in.Title), AirbnbID: in.AirbnbID, Status: in.Status, DateRates: map[string]int64{}}
}

// Apply copies the form onto the listing; date prices stay.
func (l *Listing) Apply(in ListingInput) {
	l.AccountID, l.UnitID, l.Title, l.AirbnbID, l.Status = in.AccountID, in.UnitID, strings.TrimSpace(in.Title), in.AirbnbID, in.Status
}

// ValidateListingStatus checks the status switch.
func ValidateListingStatus(status string) error {
	var f errs.Fields
	validStatus(&f, status)
	return f.Err()
}

// ValidatePrice is validateListingPrice. TypeScript walks the nights in the order the form sent
// them and keeps the last error; Go walks them by date for a stable answer.
func ValidatePrice(in PriceInput) error {
	var f errs.Fields
	if !wholePositive(in.BaseRate) {
		f.Add("baseRate", "Enter the base price in whole rupiah.")
	}
	dateErr := ""
	for _, date := range sortedKeys(in.DateRates) {
		rate := in.DateRates[date]
		if _, err := clock.ParseDate(date); !isoDateRe.MatchString(date) || err != nil {
			dateErr = "Pick the night to price."
		} else if rate != nil && !wholePositive(*rate) {
			dateErr = "Enter the price for " + date + " in whole rupiah."
		}
	}
	if dateErr != "" {
		f.Add("dateRates", dateErr)
	}
	return f.Err()
}

// ApplyPrices sets and clears nights as the mock does: a null night, or one priced at the new base
// rate, falls back to the base rate. It returns the base rate in whole rupiah.
func (l *Listing) ApplyPrices(in PriceInput) int64 {
	base := int64(in.BaseRate)
	rates := make(map[string]int64, len(l.DateRates)+len(in.DateRates))
	for d, r := range l.DateRates {
		rates[d] = r
	}
	for d, r := range in.DateRates {
		if r == nil || int64(*r) == base {
			delete(rates, d)
		} else {
			rates[d] = int64(*r)
		}
	}
	l.DateRates = rates
	return base
}

// Night is one night of a price list.
type Night struct {
	Date   string `json:"date"`
	Rate   int64  `json:"rate"`
	Custom bool   `json:"custom"`
}

// Nights is quoteNights with the source of each price: every night from `from` to the night
// before `to`, at its date price or the base rate.
func Nights(baseRate int64, dateRates map[string]int64, from, to string) []Night {
	n := max(0, clock.DaysBetween(from, to))
	out := make([]Night, 0, n)
	for i := range n {
		date := clock.AddDays(from, i)
		rate, custom := dateRates[date]
		if !custom {
			rate = baseRate
		}
		out = append(out, Night{Date: date, Rate: rate, Custom: custom})
	}
	return out
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// ShiftDateRates moves every priced night by days, for the seed.
func ShiftDateRates(rates map[string]int64, days int) map[string]int64 {
	out := make(map[string]int64, len(rates))
	for d, r := range rates {
		out[clock.AddDays(d, days)] = r
	}
	return out
}
