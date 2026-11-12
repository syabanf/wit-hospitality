// Package services is the published language of the services context: the events it publishes
// and the site menu client (SiteMenuHTTP).
// Orders, menu items and requests travel in the console's JSON shape with the villa and location
// they sit in; delivered and voided orders also carry the lines priced for the folio, so billing,
// inventory and finance act on one event without calling back. Other contexts may import this
// package and nothing below it.
package services

import "encoding/json"

// Event types; the suffix is the payload version.
const (
	EventOrderPlaced = "services.order.placed.v1"
	// EventOrderStatusChanged follows every step on the board, delivered and voided included.
	EventOrderStatusChanged = "services.order.status_changed.v1"
	// EventOrderDelivered is what billing posts to the folio, inventory takes out of the minibar
	// store and finance books as partner costs owed.
	EventOrderDelivered = "services.order.delivered.v1"
	// EventOrderVoided undoes a delivery on its business day.
	EventOrderVoided   = "services.order.voided.v1"
	EventOrderAssigned = "services.order.assigned.v1"
	EventMenuItemSaved = "services.menu_item.saved.v1"
	EventPartnerSaved  = "services.partner.saved.v1"
	EventRequestSaved  = "services.request.saved.v1"
)

// PartnerCostCategory is where a partner's share of a delivered order is booked.
const PartnerCostCategory = "cat-svc-partner"

// EventCashOutDecided is what finance publishes when it books a cash-out another context's fact
// asked for (status submitted) and on every status change after. Services keeps the answers whose
// source is a delivered order: the partner bills. The payload is CashOutDecided.
const EventCashOutDecided = "finance.cash_out.decided.v1"

// SourcePartnerBill is the source type finance gives a partner's bill; its source id is the order.
const SourcePartnerBill = "service_order"

// CashOutDecided is the payload services expects on finance.cash_out.decided.v1. Version increases
// with every status change, so a late event cannot roll a status back.
type CashOutDecided struct {
	TransactionID string `json:"transactionId"`
	Number        string `json:"number"`
	Status        string `json:"status"`
	Version       int64  `json:"version"`
	SourceType    string `json:"sourceType"`
	SourceID      string `json:"sourceId"`
	PartnerID     string `json:"partnerId"`
}

// OrderRecord is the payload of order.placed and order.assigned: Order is a ServiceOrder.
type OrderRecord struct {
	ID         string          `json:"id"`
	VillaID    string          `json:"villaId"`
	LocationID string          `json:"locationId"`
	BookingID  string          `json:"bookingId"`
	Order      json.RawMessage `json:"order"`
}

// OrderStatusChanged is the payload of order.status_changed.
type OrderStatusChanged struct {
	OrderRecord
	From string `json:"from"`
	To   string `json:"to"`
	Note string `json:"note"`
}

// BilledLine is one order line priced for the folio.
type BilledLine struct {
	ItemID            string  `json:"itemId"`
	Name              string  `json:"name"`
	Category          string  `json:"category"`
	TransactionCode   string  `json:"transactionCode"`
	RevenueCategoryID string  `json:"revenueCategoryId"`
	Unit              string  `json:"unit"`
	Quantity          float64 `json:"quantity"`
	UnitPrice         int64   `json:"unitPrice"`
	Amount            int64   `json:"amount"`
	Comp              bool    `json:"comp"`
	PartnerID         *string `json:"partnerId"`
	UnitCost          int64   `json:"unitCost"`
	Cost              int64   `json:"cost"`
}

// Totals is OrderTotals.
type Totals struct {
	Gross    int64 `json:"gross"`
	Comp     int64 `json:"comp"`
	Discount int64 `json:"discount"`
	Charge   int64 `json:"charge"`
	Cost     int64 `json:"cost"`
	Margin   int64 `json:"margin"`
}

// CodeAmount is the charge under one transaction code.
type CodeAmount struct {
	Code   string `json:"code"`
	Amount int64  `json:"amount"`
}

// CategoryAmount is the charge under one income category.
type CategoryAmount struct {
	CategoryID string `json:"categoryId"`
	Amount     int64  `json:"amount"`
}

// PartnerCost is what one partner bills the villa for the order.
type PartnerCost struct {
	PartnerID   string   `json:"partnerId"`
	PartnerName string   `json:"partnerName"`
	CategoryID  string   `json:"categoryId"`
	Amount      int64    `json:"amount"`
	ItemIDs     []string `json:"itemIds"`
}

// OrderBilled is the payload of order.delivered and order.voided. On is the delivery day (the
// void day for a void), At the delivery minute. Codes and Revenue split Totals.Charge.
type OrderBilled struct {
	OrderID        string           `json:"orderId"`
	Number         string           `json:"number"`
	BookingID      string           `json:"bookingId"`
	UnitID         string           `json:"unitId"`
	VillaID        string           `json:"villaId"`
	LocationID     string           `json:"locationId"`
	PlacedBy       string           `json:"placedBy"`
	On             string           `json:"on"`
	At             int              `json:"at"`
	Lines          []BilledLine     `json:"lines"`
	DiscountPct    float64          `json:"discountPct"`
	DiscountReason string           `json:"discountReason"`
	CompReason     string           `json:"compReason"`
	Totals         Totals           `json:"totals"`
	Codes          []CodeAmount     `json:"codes"`
	Revenue        []CategoryAmount `json:"revenue"`
	PartnerCosts   []PartnerCost    `json:"partnerCosts"`
	// Reason is set on a void.
	Reason string `json:"reason,omitempty"`
	// By, ByID and ByRole name who delivered or voided the order; finance writes the partner bills
	// in the deliverer's name, as the mock does.
	By     string `json:"by,omitempty"`
	ByID   string `json:"byId,omitempty"`
	ByRole string `json:"byRole,omitempty"`
}

// MenuItemSaved is the payload of menu_item.saved: Item is a MenuItem.
type MenuItemSaved struct {
	Item       json.RawMessage `json:"item"`
	LocationID string          `json:"locationId"`
}

// PartnerSaved is the payload of partner.saved: Partner is a ServicePartner.
type PartnerSaved struct {
	Partner json.RawMessage `json:"partner"`
}

// RequestSaved is the payload of request.saved: Request is a ServiceRequest.
type RequestSaved struct {
	Request    json.RawMessage `json:"request"`
	VillaID    string          `json:"villaId"`
	LocationID string          `json:"locationId"`
}
