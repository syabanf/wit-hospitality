// Package finance is the published language of the finance context: the events it publishes and
// the client other contexts call to read back what happened to the cash entries they asked for.
// Other contexts may import this package and nothing below it.
package finance

// Event types; the suffix is the payload version.
const (
	// EventEntryApproved follows the last signature on a cash entry.
	EventEntryApproved = "finance.entry.approved.v1"
	// EventEntryRejected follows a rejection, and an entry another context asked for that finance
	// could not take for approval (a hand-written cash-out without its receipt).
	EventEntryRejected = "finance.entry.rejected.v1"
	// EventEntryPosted follows a posting, a reversal's own posting included.
	EventEntryPosted = "finance.entry.posted.v1"
	// EventEntryReversed follows the reversal of a posted entry; Entry is the reversed one.
	EventEntryReversed = "finance.entry.reversed.v1"
	// EventCashOutDecided answers the context a cash-out was written for (maintenance, inventory,
	// housekeeping, services) when finance books it for approval (status submitted) and on every
	// status change after: { transactionId, number, status, rejectionReason, version, sourceType,
	// sourceId, partnerId }.
	EventCashOutDecided = "finance.cash_out.decided.v1"
)

// Source names the record of another context an entry was written for: a payment ("payment",
// "payment_fee"), a refund ("refund"), a maintenance expense ("maintenance_expense"), a stock
// purchase ("stock_purchase"), a payroll ("payroll"), a walk ("walk"), a city ledger payment
// ("city_ledger_payment") or a delivered room service order a partner bills ("service_order").
type Source struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// Entry is a cash entry as other contexts see it.
type Entry struct {
	TransactionID   string  `json:"transactionId"`
	Number          string  `json:"number"`
	Status          string  `json:"status"`
	Kind            string  `json:"kind"`
	CategoryID      string  `json:"categoryId"`
	AccountID       string  `json:"accountId"`
	Amount          int64   `json:"amount"`
	Date            string  `json:"date"`
	LocationID      string  `json:"locationId"`
	VillaID         *string `json:"villaId"`
	BookingID       *string `json:"bookingId"`
	Reference       string  `json:"reference"`
	RejectionReason *string `json:"rejectionReason"`
	ReversalOf      *string `json:"reversalOf"`
	ReversedBy      *string `json:"reversedBy"`
	// Source is the record the entry was written for; nil for an entry staff recorded by hand.
	Source *Source `json:"source"`
}

// EntryEvent is the payload of the entry events: the entry after the change and who made it.
type EntryEvent struct {
	Entry
	// SourceRef is the id of the fact the entry was made from (a payout request's sourceRef, a
	// payment id); empty for an entry staff wrote.
	SourceRef string `json:"sourceRef"`
	By        string `json:"by"`
	On        string `json:"on"`
}
