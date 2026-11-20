package inventory

// EventDamageCharged asks billing to post a damaged or missing item a post-departure check found on
// the stay's folio. Payload DamageCharged; billing posts it once per SourceRef.
const EventDamageCharged = "inventory.damage.charged.v1"

// DamageCharged is the folio charge of one check line (villa-operations-contract.md section 2).
type DamageCharged struct {
	// SourceRef is "<checkId>:<itemId>".
	SourceRef   string `json:"sourceRef"`
	BookingID   string `json:"bookingId"`
	BookingCode string `json:"bookingCode"`
	UnitID      string `json:"unitId"`
	VillaID     string `json:"villaId"`
	LocationID  string `json:"locationId"`
	Code        string `json:"code"`
	Description string `json:"description"`
	Amount      int64  `json:"amount"`
	By          string `json:"by"`
	ByID        string `json:"byId"`
	At          string `json:"at"`
}
