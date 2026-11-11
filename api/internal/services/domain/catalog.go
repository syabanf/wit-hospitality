package domain

// Villa is a villa as services sees it.
type Villa struct {
	ID         string
	LocationID string
	Name       string
}

// Unit is a unit as services sees it.
type Unit struct {
	ID      string
	VillaID string
	Code    string
	Name    string
	Status  string
}

// Place is where a unit sits.
type Place struct {
	Unit         Unit
	Villa        Villa
	LocationName string
}
