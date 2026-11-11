package domain

import (
	"slices"

	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Villa and Location are what finance keeps of property's catalog.
type (
	Villa struct {
		ID         string
		LocationID string
		Name       string
	}
	Location struct {
		ID   string
		Name string
		Area string
	}
)

// Places is the catalog copy.
type Places struct {
	Villas    []Villa
	Locations []Location
}

// Villa finds a villa.
func (p Places) Villa(id string) (Villa, bool) {
	i := slices.IndexFunc(p.Villas, func(v Villa) bool { return v.ID == id })
	if i < 0 {
		return Villa{}, false
	}
	return p.Villas[i], true
}

// FirstLocation is s.locations[0]?.id, the mock's fallback location.
func (p Places) FirstLocation() string {
	if len(p.Locations) == 0 {
		return ""
	}
	return p.Locations[0].ID
}

// Scope narrows the ledger the way the console's financeWorld narrows it: a location is seen when
// it holds a villa in scope, petty cash follows its villa, the bank serves everyone.
type Scope struct {
	rbac.Scope
	Places Places
}

// Location reports a location in scope.
func (s Scope) Location(id string) bool {
	if !s.Restricted() {
		return true
	}
	if len(s.VillaIDs) > 0 {
		return slices.ContainsFunc(s.Places.Villas, func(v Villa) bool { return v.LocationID == id && slices.Contains(s.VillaIDs, v.ID) })
	}
	return slices.Contains(s.LocationIDs, id)
}

// VillaSeen reports a villa in scope.
func (s Scope) VillaSeen(id string) bool {
	v, _ := s.Places.Villa(id)
	return s.AllowedVilla(id, v.LocationID)
}

// Account reports a cash account in scope.
func (s Scope) Account(a CashAccount) bool {
	if a.VillaID != nil {
		return s.VillaSeen(*a.VillaID)
	}
	return a.LocationID == nil || s.Location(*a.LocationID)
}

// Transaction reports an entry in scope: its location and its account.
func (s Scope) Transaction(t Transaction, accounts map[string]CashAccount) bool {
	a, ok := accounts[t.AccountID]
	return ok && s.Location(t.LocationID) && s.Account(a)
}

// Journal reports a journal entry in scope: a restricted user sees their villas' entries only.
func (s Scope) Journal(villaID *string) bool {
	if !s.Restricted() {
		return true
	}
	return villaID != nil && s.VillaSeen(*villaID)
}
