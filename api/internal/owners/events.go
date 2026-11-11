// Package owners is the published language of the owners context: the events it publishes, the
// finance events it reads, and the villa results lookup finance answers (results.go). Payloads carry
// the record in the console's JSON shape. Other contexts may import this package and nothing below
// it. docs/ARCHITECTURE.md, "Owners events", describes each one.
package owners

import "encoding/json"

// Events owners publishes; the suffix is the payload version.
const (
	EventOwnerSaved        = "owners.villa_owner.saved.v1"
	EventContractSaved     = "owners.contract.saved.v1"
	EventStatementClosed   = "owners.statement.closed.v1"
	EventStatementApproved = "owners.statement.approved.v1"
	EventStatementReopened = "owners.statement.reopened.v1"
	EventPayoutRequested   = "owners.payout.requested.v1"
	EventStayRequested     = "owners.stay.requested.v1"
	EventStayDecided       = "owners.stay.decided.v1"
)

// Finance events owners reads, keyed by the payout request's SourceRef.
const (
	EventFinanceEntryApproved = "finance.entry.approved.v1"
	EventFinanceEntryPosted   = "finance.entry.posted.v1"
	EventFinanceEntryRejected = "finance.entry.rejected.v1"
)

// OwnerSaved is the payload of villa_owner.saved: Owner is a VillaOwner.
type OwnerSaved struct {
	Owner json.RawMessage `json:"owner"`
}

// ContractSaved is the payload of contract.saved: Contract is a ManagementContract.
type ContractSaved struct {
	Contract   json.RawMessage `json:"contract"`
	VillaID    string          `json:"villaId"`
	LocationID string          `json:"locationId"`
}

// StatementEvent is the payload of statement.closed, statement.approved and statement.reopened.
// Statement is the OwnerStatement with its figures, stays and entries. Journal is set on closed
// (the close entry) and reopened (its reversal); finance writes it. Reason is set on reopened.
type StatementEvent struct {
	Statement  json.RawMessage `json:"statement"`
	VillaID    string          `json:"villaId"`
	LocationID string          `json:"locationId"`
	Journal    json.RawMessage `json:"journal,omitempty"`
	Reason     string          `json:"reason,omitempty"`
}

// PayoutRequested asks finance for the cash entry that settles an approved statement: a bank
// cash-out to the owner, or a cash-in when the owner tops up a shortfall. Finance submits it for
// approval and reports back with SourceRef.
type PayoutRequested struct {
	SourceRef       string `json:"sourceRef"`
	StatementID     string `json:"statementId"`
	StatementNumber string `json:"statementNumber"`
	Kind            string `json:"kind"`
	AccountID       string `json:"accountId"`
	CategoryID      string `json:"categoryId"`
	Amount          int64  `json:"amount"`
	Date            string `json:"date"`
	VillaID         string `json:"villaId"`
	LocationID      string `json:"locationId"`
	Description     string `json:"description"`
	Reference       string `json:"reference"`
	Origin          string `json:"origin"`
}

// StayRequested is the payload of stay.requested: Request is an OwnerStayRequest.
type StayRequested struct {
	Request json.RawMessage `json:"request"`
}

// StayBlock is the owner block an approved stay puts on a unit; property adds it with this id.
type StayBlock struct {
	ID     string `json:"id"`
	UnitID string `json:"unitId"`
	From   string `json:"from"`
	To     string `json:"to"`
	Reason string `json:"reason"`
	Note   string `json:"note"`
}

// StayDecided is the payload of stay.decided. Block is set when the stay is approved.
type StayDecided struct {
	Request    json.RawMessage `json:"request"`
	VillaID    string          `json:"villaId"`
	LocationID string          `json:"locationId"`
	Block      *StayBlock      `json:"block"`
}

// FinanceEntry is the part of finance.entry.approved, posted and rejected that owners reads.
type FinanceEntry struct {
	TransactionID string `json:"transactionId"`
	Number        string `json:"number"`
	Status        string `json:"status"`
	SourceRef     string `json:"sourceRef"`
}
