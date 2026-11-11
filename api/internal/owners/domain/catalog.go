package domain

// Villa is owners' copy of a villa.
type Villa struct {
	ID         string `json:"id"`
	LocationID string `json:"locationId"`
	Code       string `json:"code"`
	Name       string `json:"name"`
}

// Unit is owners' copy of a unit.
type Unit struct {
	ID      string `json:"id"`
	VillaID string `json:"villaId"`
	Code    string `json:"code"`
	Status  string `json:"status"`
}

// Holder is the stay or block that already holds a unit on some of the nights asked for.
type Holder struct {
	Label string
	From  string
	To    string
}
