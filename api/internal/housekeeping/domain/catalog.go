package domain

// Unit is a unit as housekeeping sees it, from property's events.
type Unit struct {
	ID      string
	VillaID string
	GroupID *string
	Code    string
	Status  string
}

// Villa is a villa and its location, for scope and audit lines.
type Villa struct {
	ID         string
	LocationID string
	Name       string
}

// Group is a room type, for linen pars.
type Group struct {
	ID      string
	VillaID string
	Name    string
}

// Stay is a booking as housekeeping sees it, from reservation's events.
type Stay struct {
	ID           string
	Code         string
	UnitID       string
	UnitAssigned bool
	Status       string
	CheckIn      string
	CheckOut     string
}
