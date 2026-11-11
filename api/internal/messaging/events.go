// Package messaging is the published language of the messaging context: the event it publishes
// and the names and payloads of the billing events it consumes. Other contexts may import this
// package and nothing below it.
package messaging

import "encoding/json"

// EventMessageSaved follows every message queued, sent again or moved on by the provider's answer
// at send time. Data is the Message in the console's shape.
const EventMessageSaved = "messaging.message.saved.v1"

// MessageSaved is the payload of message.saved. VillaID is empty for a city ledger invoice.
type MessageSaved struct {
	ID      string          `json:"id"`
	VillaID string          `json:"villaId"`
	Data    json.RawMessage `json:"data"`
}

// Billing events messaging consumes. Billing is built in parallel; these are the names and
// payloads messaging expects it to publish (docs/ARCHITECTURE.md, Messaging).
const (
	// EventPaymentLinkCreated fires the payment_link template, every time.
	EventPaymentLinkCreated = "billing.payment_link.created.v1"
	// EventPaymentLinkUpdated keeps messaging's copy of the link (paid, cancelled, expired), so a
	// payment_link sent by hand carries only a pending link.
	EventPaymentLinkUpdated = "billing.payment_link.updated.v1"
	// EventPaymentReceived fires the payment_received template, every time.
	EventPaymentReceived = "billing.payment.received.v1"
)

// PaymentLink is the part of billing's PaymentLink messaging reads; the token is its key.
type PaymentLink struct {
	BookingID string `json:"bookingId"`
	Token     string `json:"token"`
	Amount    int64  `json:"amount"`
	Status    string `json:"status"`
}

// PaymentLinkEvent is the payload of payment_link.created and payment_link.updated.
type PaymentLinkEvent struct {
	Link PaymentLink `json:"link"`
}

// PaymentReceived is the payload of payment.received: a guest payment that settled.
type PaymentReceived struct {
	PaymentID string `json:"paymentId"`
	BookingID string `json:"bookingId"`
	Amount    int64  `json:"amount"`
}
