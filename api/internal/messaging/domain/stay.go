package domain

// Stay is a booking as messaging sees it, from reservation's events.
type Stay struct {
	ID           string
	Code         string
	GuestID      string
	UnitID       string
	UnitAssigned bool
	Status       string
	CheckIn      string
	CheckOut     string
	GroupID      string
}

// Guest is a guest's contact, from guest's events.
type Guest struct {
	ID          string
	Name        string
	Email       string
	Phone       string
	Nationality string
}

// Place is where a unit sits, from property's events.
type Place struct {
	VillaID    string
	LocationID string
	VillaName  string
	UnitCode   string
	GroupName  string
}
