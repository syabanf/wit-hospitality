package owners

import "context"

// Results is the lookup a statement reads its figures from. Finance implements it: the villa P&L
// (`pnl-villa`) for one villa and month. Until finance does, owners/adapters/results.Stub answers
// from reservation's stays alone.
type Results interface {
	VillaResults(ctx context.Context, villaID, month string) (VillaResult, error)
}

// VillaResult is one villa's month by the villa P&L rules.
type VillaResult struct {
	// Stays earn room revenue night by night inside the month; Fee is the Airbnb fee of an arrival
	// in the month.
	Stays []ResultStay `json:"stays"`
	// Entries are the villa's posted entries dated in the month with their role in the villa P&L
	// ("other" income or "expense"); entries the P&L leaves out are not listed.
	Entries []ResultEntry `json:"entries"`
	// Payroll is the villa's share of the month's closed payroll.
	Payroll int64 `json:"payroll"`
	// Pending counts the villa's entries dated in the month that still wait for approval or posting.
	Pending int `json:"pending"`
}

// ResultStay is one stay's share of the month, without the guest.
type ResultStay struct {
	BookingID string `json:"bookingId"`
	Code      string `json:"code"`
	UnitCode  string `json:"unitCode"`
	CheckIn   string `json:"checkIn"`
	CheckOut  string `json:"checkOut"`
	Source    string `json:"source"`
	Nights    int    `json:"nights"`
	Revenue   int64  `json:"revenue"`
	Fee       int64  `json:"fee"`
}

// ResultEntry is one villa entry.
type ResultEntry struct {
	TransactionID string `json:"transactionId"`
	Number        string `json:"number"`
	Date          string `json:"date"`
	Description   string `json:"description"`
	Category      string `json:"category"`
	CategoryID    string `json:"categoryId"`
	Origin        string `json:"origin"`
	Role          string `json:"role"`
	Amount        int64  `json:"amount"`
}
