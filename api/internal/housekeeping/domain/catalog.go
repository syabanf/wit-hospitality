package domain

// Unit is a unit as housekeeping sees it, from property's events.
type Unit struct {
	ID      string
	VillaID string
	GroupID *string
	Code    string
	Status  string
}

// Villa is a villa and its location, for scope and audit lines, and how it operates: villa, hotel
// or mixed, and the days between stayover cleans of a guest in house (0 none).
type Villa struct {
	ID            string
	LocationID    string
	Name          string
	Operation     string
	StayoverEvery int
}

// Group is a room type, for linen pars; Kind is room or villa.
type Group struct {
	ID      string
	VillaID string
	Name    string
	Kind    string
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

// Operations and kinds as property names them.
const (
	OperationHotel = "hotel"
	OperationMixed = "mixed"
	KindRoom       = "room"
	KindVilla      = "villa"
)

// UnitKind is a unit's kind: its room type's, or without one a room in a hotel and a villa
// otherwise.
func UnitKind(v Villa, g *Group) string {
	switch {
	case g != nil:
		return g.Kind
	case v.Operation == OperationHotel:
		return KindRoom
	}
	return KindVilla
}

// StayoverEvery is the days between a unit's stayover cleans, 0 for none: the property's gap,
// except that a mixed property cleans only its rooms.
func StayoverEvery(v Villa, unitKind string) int {
	if v.Operation == OperationMixed && unitKind != KindRoom {
		return 0
	}
	return v.StayoverEvery
}
