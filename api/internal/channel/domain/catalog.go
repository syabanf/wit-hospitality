package domain

// Villa and Unit are what channel keeps of property's records, projected from property events:
// enough to scope listings and enquiries, name them, and price a listing's nights.
type Villa struct {
	ID         string
	LocationID string
	Name       string
}

// Unit is a unit as channel sees it. NightlyRate is the listing's base rate; property owns it.
type Unit struct {
	ID          string
	VillaID     string
	LocationID  string
	GroupID     *string
	Code        string
	Status      string
	NightlyRate int64
}

// Hold is SiteHold: nights a unit cannot sell, with no name, code or price. To is exclusive.
type Hold struct {
	UnitID       string `json:"unitId"`
	UnitAssigned bool   `json:"unitAssigned"`
	From         string `json:"from"`
	To           string `json:"to"`
}
