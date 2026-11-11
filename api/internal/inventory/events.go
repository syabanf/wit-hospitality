// Package inventory is the published language of the inventory context: the events it publishes
// and the payloads of the events it consumes from contexts not built yet (finance, services).
// Other contexts may import this package and nothing below it.
package inventory

// Event types; the suffix is the payload version.
const (
	// EventPurchaseSubmitted asks finance for the cash-out that pays a stock receipt.
	EventPurchaseSubmitted = "inventory.purchase.submitted.v1"
	// EventPurchaseResubmitted sends a corrected, rejected purchase back for approval.
	EventPurchaseResubmitted = "inventory.purchase.resubmitted.v1"
	// EventPurchaseCancelled closes a rejected purchase for good: its stock left the store again.
	EventPurchaseCancelled = "inventory.purchase.cancelled.v1"
	// EventStockMoved carries the movements one command booked.
	EventStockMoved = "inventory.stock.moved.v1"
	// EventStockLow says a store just reached its reorder level of an item.
	EventStockLow = "inventory.stock.low.v1"
	// EventMinibarChecked carries a minibar check as the delivered service order services will
	// bill on the stay.
	EventMinibarChecked = "inventory.minibar_check.recorded.v1"
)

// Events inventory consumes. The producing contexts are not built yet; the payloads below are
// the contract they are expected to publish.
const (
	// EventCashOutDecided: finance changed a cash-out's status. Payload CashOutDecided.
	EventCashOutDecided = "finance.cash_out.decided.v1"
	// EventOrderDelivered: a service order reached the guest; its minibar lines leave the villa
	// store. Payload OrderEvent.
	EventOrderDelivered = "services.order.delivered.v1"
	// EventOrderVoided: a delivered order was voided; its minibar stock goes back. Payload OrderEvent.
	EventOrderVoided = "services.order.voided.v1"
	// EventMenuItemSaved: a room service menu item was created or edited. Payload MenuItemSaved.
	EventMenuItemSaved = "services.menu_item.saved.v1"
)

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

// CashOut is a purchase cash-out request with the full amount, as the mock's newTransaction
// receives it. Finance picks the account: the location's cashbox for cash, the bank for a transfer.
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
	Description   string       `json:"description"`
	Reference     string       `json:"reference"`
	Attachments   []Attachment `json:"attachments"`
	CreatedByID   string       `json:"createdById"`
	CreatedBy     string       `json:"createdBy"`
	Note          string       `json:"note,omitempty"`
}

// Movement is one booked stock movement.
type Movement struct {
	ID           string  `json:"id"`
	Number       string  `json:"number"`
	VillaID      string  `json:"villaId"`
	ItemID       string  `json:"itemId"`
	Kind         string  `json:"kind"`
	Quantity     int     `json:"quantity"`
	UnitCost     int64   `json:"unitCost"`
	On           string  `json:"on"`
	UnitID       *string `json:"unitId"`
	BookingID    *string `json:"bookingId"`
	OrderID      *string `json:"orderId"`
	ReceiptID    *string `json:"receiptId"`
	TransferID   *string `json:"transferId"`
	OtherVillaID *string `json:"otherVillaId"`
	Reason       string  `json:"reason"`
}

// StockMoved is the payload of stock.moved.
type StockMoved struct {
	Movements []Movement `json:"movements"`
}

// StockLow is the payload of stock.low.
type StockLow struct {
	VillaID      string `json:"villaId"`
	ItemID       string `json:"itemId"`
	ItemName     string `json:"itemName"`
	OnHand       int    `json:"onHand"`
	ReorderLevel int    `json:"reorderLevel"`
}

// OrderLine is a service order line, as services publishes it.
type OrderLine struct {
	ItemID    string  `json:"itemId"`
	Name      string  `json:"name"`
	Category  string  `json:"category"`
	Unit      string  `json:"unit"`
	Price     int64   `json:"price"`
	Quantity  int     `json:"quantity"`
	CostPrice int64   `json:"costPrice"`
	PartnerID *string `json:"partnerId"`
	Comp      bool    `json:"comp"`
}

// Order is the part of a service order inventory reads.
type Order struct {
	ID        string      `json:"id"`
	Number    string      `json:"number"`
	BookingID string      `json:"bookingId"`
	UnitID    string      `json:"unitId"`
	VillaID   string      `json:"villaId"`
	Lines     []OrderLine `json:"lines"`
}

// OrderEvent is the payload inventory expects on services.order.delivered.v1 and .voided.v1.
// By names who delivered or voided it.
type OrderEvent struct {
	Order Order  `json:"order"`
	By    string `json:"by"`
}

// MinibarChecked is the payload of minibar_check.recorded: the delivered order services adopts
// (same id and number) and bills on the stay. Services must not publish order.delivered for it:
// the restock, if any, already left the store.
type MinibarChecked struct {
	Order       Order  `json:"order"`
	Note        string `json:"note"`
	Restocked   bool   `json:"restocked"`
	DeliveredOn string `json:"deliveredOn"`
	DeliveredAt int    `json:"deliveredAt"`
	By          string `json:"by"`
}

// MenuItem is the part of a menu item inventory keeps.
type MenuItem struct {
	ID       string `json:"id"`
	VillaID  string `json:"villaId"`
	Category string `json:"category"`
	Name     string `json:"name"`
	Unit     string `json:"unit"`
	Price    int64  `json:"price"`
	Active   bool   `json:"active"`
}

// MenuItemSaved is the payload inventory expects on services.menu_item.saved.v1.
type MenuItemSaved struct {
	MenuItem MenuItem `json:"menuItem"`
	Version  int64    `json:"version"`
}

// CashOutDecided is the payload inventory expects on finance.cash_out.decided.v1.
type CashOutDecided struct {
	TransactionID   string `json:"transactionId"`
	Number          string `json:"number"`
	Status          string `json:"status"`
	RejectionReason string `json:"rejectionReason"`
	Version         int64  `json:"version"`
}
