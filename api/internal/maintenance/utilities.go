package maintenance

// EventUtilityBilled bills a meter reading's usage to the guest's folio (billing) or to the owner
// statement (owners), once per reading. Payload UtilityBilled.
const EventUtilityBilled = "maintenance.utility.billed.v1"

// UtilityBilled is one reading's bill (villa-operations-contract.md section 3).
type UtilityBilled struct {
	ReadingID   string  `json:"readingId"`
	Payer       string  `json:"payer"`
	BookingID   *string `json:"bookingId"`
	BookingCode *string `json:"bookingCode"`
	MeterID     string  `json:"meterId"`
	MeterNumber string  `json:"meterNumber"`
	Kind        string  `json:"kind"`
	Unit        string  `json:"unit"`
	Usage       float64 `json:"usage"`
	Tariff      int64   `json:"tariff"`
	Amount      int64   `json:"amount"`
	VillaID     string  `json:"villaId"`
	LocationID  string  `json:"locationId"`
	Month       string  `json:"month"`
	On          string  `json:"on"`
	Description string  `json:"description"`
	By          string  `json:"by"`
	ByID        string  `json:"byId"`
}
