package postgres

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/services"
)

// Orders reads billing's copy of the room service orders; it satisfies command.Orders.
type Orders struct{ DB *db.DB }

// StayOrders lists a stay's delivered and voided orders in the order they reached the bill.
func (o Orders) StayOrders(ctx context.Context, bookingID string) ([]domain.Order, error) {
	rows, err := o.DB.Q(ctx).Query(ctx, `SELECT doc FROM billing.rm_orders WHERE booking_id = $1 ORDER BY version, id`, bookingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []domain.Order
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var x domain.Order
		if err := json.Unmarshal(raw, &x); err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

// Order reads one order of the copy; ok is false when billing has none.
func (o Orders) Order(ctx context.Context, id string) (domain.Order, bool, error) {
	var raw []byte
	err := o.DB.Q(ctx).QueryRow(ctx, `SELECT doc FROM billing.rm_orders WHERE id = $1`, id).Scan(&raw)
	if db.NoRows(err) {
		return domain.Order{}, false, nil
	}
	if err != nil {
		return domain.Order{}, false, err
	}
	var x domain.Order
	err = json.Unmarshal(raw, &x)
	return x, true, err
}

// PutOrder saves the copy of an order.
func (o Orders) PutOrder(ctx context.Context, x domain.Order) error {
	raw, err := json.Marshal(x)
	if err != nil {
		return err
	}
	_, err = o.DB.Q(ctx).Exec(ctx, `
		INSERT INTO billing.rm_orders (id, booking_id, status, doc) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET booking_id = EXCLUDED.booking_id, status = EXCLUDED.status, doc = EXCLUDED.doc,
			version = billing.rm_orders.version + 1`, x.ID, x.BookingID, x.Status, raw)
	return err
}

// orderOf is the folio's view of a billed order: its lines at the menu price, the discount, the
// delivery day and minute, and the charge per code as services split it.
func orderOf(b services.OrderBilled, status string) domain.Order {
	on, at := b.On, b.At
	x := domain.Order{ID: b.OrderID, Number: b.Number, BookingID: b.BookingID, Status: status, RequestedOn: on, RequestedAt: at, DeliveredOn: &on,
		DeliveredAt: &at, DiscountPct: b.DiscountPct, DiscountReason: b.DiscountReason, CompReason: b.CompReason, Assignee: "Room service",
		History: []domain.OrderHistory{}, Lines: make([]domain.OrderLine, len(b.Lines)), Codes: make([]domain.CodeAmount, len(b.Codes))}
	for i, l := range b.Lines {
		x.Lines[i] = domain.OrderLine{Name: l.Name, Category: l.Category, Price: float64(l.UnitPrice), Quantity: l.Quantity, Comp: l.Comp}
	}
	for i, c := range b.Codes {
		x.Codes[i] = domain.CodeAmount{Code: c.Code, Amount: c.Amount}
	}
	return x
}
