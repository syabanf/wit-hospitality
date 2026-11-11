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

// Payment link events messaging consumes. Billing publishes none yet; these are the names and
// payloads messaging expects (docs/ARCHITECTURE.md, Messaging). A payment that lands arrives as
// billing.payment.recorded.v1, which billing publishes.
const (
	// EventPaymentLinkCreated fires the payment_link template, every time.
	EventPaymentLinkCreated = "billing.payment_link.created.v1"
	// EventPaymentLinkUpdated keeps messaging's copy of the link (paid, cancelled, expired), so a
	// payment_link sent by hand carries only a pending link.
	EventPaymentLinkUpdated = "billing.payment_link.updated.v1"
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
