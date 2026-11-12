// Package maintenance is the published language of the maintenance context: the events it
// publishes, the payloads of the events it consumes, and the work order client housekeeping calls
// (workorders_client.go). Other contexts may import this package and nothing below it.
package maintenance

// Event types; the suffix is the payload version.
const (
	// EventWorkOrderSaved carries a work order after every change.
	EventWorkOrderSaved = "maintenance.work_order.saved.v1"
	// EventExpenseSubmitted asks finance for a cash-out that pays a work order expense line.
	EventExpenseSubmitted = "maintenance.expense.submitted.v1"
	// EventExpenseResubmitted sends a corrected, rejected expense back for approval.
	EventExpenseResubmitted = "maintenance.expense.resubmitted.v1"
)

// EventCashOutDecided is what finance publishes when a cash-out changes status (approved,
// rejected, posted, reversed). Finance is not built yet; maintenance consumes it to keep the
// local status of its expense lines. The payload is CashOutDecided.
const EventCashOutDecided = "finance.cash_out.decided.v1"

// WorkOrder is a work order's state, enough for housekeeping and reports.
type WorkOrder struct {
	ID         string  `json:"id"`
	Number     string  `json:"number"`
	VillaID    string  `json:"villaId"`
	LocationID string  `json:"locationId"`
	UnitID     *string `json:"unitId"`
	AssetID    *string `json:"assetId"`
	PlanID     *string `json:"planId"`
	VendorID   *string `json:"vendorId"`
	Category   string  `json:"category"`
	Priority   string  `json:"priority"`
	Title      string  `json:"title"`
	Status     string  `json:"status"`
	BlockID    *string `json:"blockId"`
	CreatedOn  string  `json:"createdOn"`
	FinishedOn *string `json:"finishedOn"`
	Cost       int64   `json:"cost"`
}

// WorkOrderSaved is the payload of work_order.saved.
type WorkOrderSaved struct {
	WorkOrder WorkOrder `json:"workOrder"`
}

// CashOut is a cash-out request with the full amount, as the mock's newTransaction receives it.
// Finance picks the account: the location's cashbox for cash, the bank for a transfer.
type CashOut struct {
	TransactionID string       `json:"transactionId"`
	Number        string       `json:"number"`
	Origin        string       `json:"origin"`
	SourceID      string       `json:"sourceId"`
	Kind          string       `json:"kind"`
	CategoryID    string       `json:"categoryId"`
	Method        string       `json:"method"`
	Amount        int64        `json:"amount"`
	Date          string       `json:"date"`
	LocationID    string       `json:"locationId"`
	VillaID       string       `json:"villaId"`
	UnitID        *string      `json:"unitId"`
	Description   string       `json:"description"`
	Reference     string       `json:"reference"`
	Attachments   []Attachment `json:"attachments"`
	CreatedByID   string       `json:"createdById"`
	CreatedBy     string       `json:"createdBy"`
	Note          string       `json:"note,omitempty"`
}

// Attachment is a stored file reference.
type Attachment struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Type       string `json:"type"`
	Size       int64  `json:"size"`
	URL        string `json:"url"`
	UploadedBy string `json:"uploadedBy"`
	UploadedAt string `json:"uploadedAt"`
}

// CashOutDecided is the payload maintenance expects on finance.cash_out.decided.v1. Version
// increases with every status change, so a late event cannot roll a status back.
type CashOutDecided struct {
	TransactionID   string `json:"transactionId"`
	Number          string `json:"number"`
	Status          string `json:"status"`
	RejectionReason string `json:"rejectionReason"`
	Version         int64  `json:"version"`
}
