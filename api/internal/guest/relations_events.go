package guest

import "encoding/json"

// Guest relations events (api/docs/contracts/guest-relations-contract.md).
const (
	EventComplaintSaved         = "guest.complaint.saved.v1"
	EventIncidentSaved          = "guest.incident.saved.v1"
	EventSafeBoxSaved           = "guest.safe_box.saved.v1"
	EventBoxRentalSaved         = "guest.box_rental.saved.v1"
	EventFolioPostingRequested  = "guest.folio_posting.requested.v1"
	FolioPostingCredit          = "credit"
	FolioPostingCharge          = "charge"
	ConsumerBillingGuestPosting = "billing.guest_postings"
)

// RecordSaved is the payload of complaint.saved, incident.saved, safe_box.saved and
// box_rental.saved: the record as the console reads it, with the villa and location it sits in.
type RecordSaved struct {
	Record     json.RawMessage `json:"record"`
	VillaID    string          `json:"villaId"`
	LocationID string          `json:"locationId"`
}

// FolioPostingRequested asks billing to post money on a stay's folio, once per SourceID
// ("complaint:<id>", "incident:<id>", "box-rental:<id>"). A credit comes off the bill with service
// and PB1 inside the amount; a charge posts on DMG as typed.
type FolioPostingRequested struct {
	SourceID    string `json:"sourceId"`
	BookingID   string `json:"bookingId"`
	VillaID     string `json:"villaId"`
	Kind        string `json:"kind"`
	Amount      int64  `json:"amount"`
	Description string `json:"description"`
	By          string `json:"by"`
	ByID        string `json:"byId"`
}
