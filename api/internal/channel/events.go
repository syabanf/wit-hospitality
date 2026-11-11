// Package channel is the published language of the channel context: the events it publishes and
// the price lookup it answers for other contexts (prices.go). Payloads carry the full state of the
// record plus the villa and location it sits in. Other contexts may import this package and
// nothing below it.
package channel

// Event types; the suffix is the payload version.
const (
	EventAccountCreated  = "channel.airbnb_account.created.v1"
	EventAccountUpdated  = "channel.airbnb_account.updated.v1"
	EventListingCreated  = "channel.listing.created.v1"
	EventListingUpdated  = "channel.listing.updated.v1"
	EventListingPriced   = "channel.listing.priced.v1"
	EventEnquiryReceived = "channel.enquiry.received.v1"
	EventEnquiryUpdated  = "channel.enquiry.updated.v1"
)

// Account is an Airbnb host account's state.
type Account struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Email  string `json:"email"`
	Status string `json:"status"`
	Slot   int    `json:"slot"`
}

// Listing is an Airbnb listing's state: one per unit, with the nights priced away from the base.
type Listing struct {
	ID        string           `json:"id"`
	AccountID string           `json:"accountId"`
	UnitID    string           `json:"unitId"`
	Title     string           `json:"title"`
	AirbnbID  string           `json:"airbnbId"`
	Status    string           `json:"status"`
	DateRates map[string]int64 `json:"dateRates"`
}

// Enquiry is a web enquiry's state.
type Enquiry struct {
	ID        string  `json:"id"`
	Number    string  `json:"number"`
	Topic     string  `json:"topic"`
	VillaID   string  `json:"villaId"`
	GroupID   *string `json:"groupId"`
	CheckIn   string  `json:"checkIn"`
	CheckOut  string  `json:"checkOut"`
	Guests    int     `json:"guests"`
	Status    string  `json:"status"`
	BookingID *string `json:"bookingId"`
	CreatedOn string  `json:"createdOn"`
}

// AccountEvent is the payload of airbnb_account.created and airbnb_account.updated.
type AccountEvent struct {
	Account Account `json:"account"`
}

// ListingEvent is the payload of listing.created and listing.updated.
type ListingEvent struct {
	Listing    Listing `json:"listing"`
	VillaID    string  `json:"villaId"`
	LocationID string  `json:"locationId"`
}

// ListingPriced is the payload of listing.priced. BaseRate is the price the user set for every
// night without a date price; property owns it as the unit's nightly rate and follows this event.
type ListingPriced struct {
	Listing    Listing `json:"listing"`
	BaseRate   int64   `json:"baseRate"`
	VillaID    string  `json:"villaId"`
	LocationID string  `json:"locationId"`
}

// EnquiryEvent is the payload of enquiry.received and enquiry.updated. It leaves out the guest's
// contact details: other contexts learn that a request exists, not who sent it.
type EnquiryEvent struct {
	Enquiry Enquiry `json:"enquiry"`
}
