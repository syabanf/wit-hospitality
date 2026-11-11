package channel

import "context"

// UnitListing is a unit's live Airbnb listing as a price list: the base rate (the unit's nightly
// rate, which property owns) and the nights priced away from it.
type UnitListing struct {
	ListingID string           `json:"listingId"`
	AccountID string           `json:"accountId"`
	UnitID    string           `json:"unitId"`
	Status    string           `json:"status"`
	BaseRate  int64            `json:"baseRate"`
	DateRates map[string]int64 `json:"dateRates"`
}

// NightPrice is one night from a listing: its date price, else the base rate.
type NightPrice struct {
	Date   string `json:"date"`
	Rate   int64  `json:"rate"`
	Custom bool   `json:"custom"`
}

// Prices answers the listing price lookups reservation needs to quote a direct stay. The monolith
// passes the channel module's in-process answer; split services pass adapters/client.HTTP, which
// calls channel's /internal/v1 routes.
type Prices interface {
	// ActiveListing returns the unit's listing when it is live, else nil: a paused listing or none
	// leaves the room type's rate plan to price the stay.
	ActiveListing(ctx context.Context, unitID string) (*UnitListing, error)
	// NightlyPrices prices each night in [from, to) from the live listing; false when the unit has
	// no live listing.
	NightlyPrices(ctx context.Context, unitID, from, to string) ([]NightPrice, bool, error)
}
