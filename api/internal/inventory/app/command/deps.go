// Package command holds the inventory context's write side: one handler per command. Every stock
// write takes the stock lock, loads the movements, checks every line against the store before any
// of them moves, books the movements, reprices the items from the replay and appends its events
// and audit line in one transaction.
package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/inventory"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Catalog references, projected from property and services events.
type (
	Villa struct {
		ID         string
		LocationID string
		Name       string
	}
	Unit struct {
		ID      string
		VillaID string
		GroupID *string
		Code    string
	}
	Group struct {
		ID      string
		VillaID string
		Name    string
	}
	MenuItem = inventory.MenuItem
)

// Stay is what inventory needs of a booking.
type Stay struct {
	ID     string
	Code   string
	Status string
	UnitID string
}

// Stays reads bookings, which the reservation context owns. Until it runs, the composition root
// passes an adapter that finds none.
type Stays interface {
	Stay(ctx context.Context, bookingID string) (Stay, error)
}

// Repository is the write model on the inventory schema.
type Repository interface {
	// Lock serialises stock writes: the average cost is one per item across every store.
	Lock(ctx context.Context) error
	Next(ctx context.Context, counter string) (int, error)
	Villa(ctx context.Context, id string) (Villa, error)
	Unit(ctx context.Context, id string) (Unit, error)
	Group(ctx context.Context, id string) (Group, error)
	MenuItem(ctx context.Context, id string) (MenuItem, error)

	Items(ctx context.Context) ([]domain.Item, error)
	Item(ctx context.Context, id string) (domain.Item, error)
	ItemCodeTaken(ctx context.Context, code, excludeID string) (bool, error)
	InsertItem(ctx context.Context, i *domain.Item) error
	UpdateItem(ctx context.Context, i *domain.Item) error
	// SetAverages stores each item's current average cost from the replay.
	SetAverages(ctx context.Context, averages map[string]int64) error

	Movements(ctx context.Context) ([]domain.Movement, error)
	InsertMovement(ctx context.Context, m domain.Movement) error
	UpdateMovement(ctx context.Context, m domain.Movement) error
	DeleteMovement(ctx context.Context, id string) error

	Receipt(ctx context.Context, id string) (domain.StockReceipt, error)
	InsertReceipt(ctx context.Context, r *domain.StockReceipt) error
	UpdateReceipt(ctx context.Context, r *domain.StockReceipt) error

	InsertCount(ctx context.Context, c domain.Count) error
	SaveKit(ctx context.Context, k domain.Kit) error
	DeleteKit(ctx context.Context, groupID string) error
	Links(ctx context.Context) ([]domain.MinibarLink, error)
	SaveLink(ctx context.Context, l domain.MinibarLink) error
	DeleteLink(ctx context.Context, menuItemID string) error
	InsertMinibarCheck(ctx context.Context, e inventory.MinibarChecked) error
}

// CashOutStatus is the local view of a cash-out finance owns.
type CashOutStatus struct {
	ID          string
	Number      string
	Status      string
	CreatedByID string
	CreatedBy   string
}

// CashOutRequests asks finance to pay. Finance is not built yet: the in-process implementation
// records each request in this context's outbox and keeps the status submitted until finance
// answers with finance.cash_out.decided.v1.
type CashOutRequests interface {
	Submit(ctx context.Context, p auth.Principal, r inventory.CashOut) (CashOutStatus, error)
	Correct(ctx context.Context, p auth.Principal, id string, r inventory.CashOut, note string) (CashOutStatus, error)
	Cancel(ctx context.Context, p auth.Principal, id, note string) error
	Status(ctx context.Context, id string) (CashOutStatus, error)
}

// Deps is what every inventory command needs.
type Deps struct {
	DB       *db.DB
	Repo     Repository
	Stays    Stays
	CashOuts CashOutRequests
	Authz    rbac.Authorizer
	Audit    audit.Recorder
	Clock    clock.Clock
}

// Permission sets the commands check, taken from src/application/stock.ts.
var (
	needCreate   = rbac.Need{Module: "maintenance", Action: "create"}
	needEdit     = rbac.Need{Module: "maintenance", Action: "edit"}
	needSubmit   = rbac.Need{Module: "maintenance", Action: "submit"}
	needApprove  = rbac.Need{Module: "maintenance", Action: "approve"}
	needServices = rbac.Need{Module: "services", Action: "create"}
)

func (d Deps) today() string { return clock.Today(d.Clock) }

// can is `can` in access.ts against the current matrix.
func (d Deps) can(ctx context.Context, p auth.Principal, n rbac.Need) (bool, error) {
	m, err := d.Authz.Source.Permissions(ctx)
	if err != nil {
		return false, err
	}
	return rbac.Can(m, p.Role, n.Module, n.Action), nil
}

func (d Deps) villaInScope(ctx context.Context, p auth.Principal, id string) (Villa, error) {
	v, err := d.Repo.Villa(ctx, id)
	if err != nil {
		return v, err
	}
	if !p.Scope().AllowedVilla(v.ID, v.LocationID) {
		return v, errs.Forbidden(fmt.Sprintf("%s is outside the villas you work with.", v.Name))
	}
	return v, nil
}

func (d Deps) record(ctx context.Context, p auth.Principal, l audit.Line) error {
	return d.Audit.Record(ctx, audit.Actor{ID: p.UserID, Name: p.Name, Role: string(p.Role)}, l)
}

func (d Deps) emit(ctx context.Context, eventType, aggregateType, id string, version int64, payload any) error {
	return outbox.Append(ctx, d.DB.Q(ctx), d.Clock.Now(), outbox.Event{Type: eventType, AggregateType: aggregateType, AggregateID: id, AggregateVersion: version, Payload: payload})
}

// Book is the stock working set of one command: every movement, the items, and what the command adds.
type Book struct {
	d      Deps
	by     string
	moves  []domain.Movement
	items  map[string]domain.Item
	order  []string
	added  []domain.Movement
	before map[[2]string]int
	replay *domain.Replay
}

// open takes the stock lock and loads the working set. by names who moved the stock.
func (d Deps) open(ctx context.Context, by string) (*Book, error) {
	if err := d.Repo.Lock(ctx); err != nil {
		return nil, err
	}
	moves, err := d.Repo.Movements(ctx)
	if err != nil {
		return nil, err
	}
	items, err := d.Repo.Items(ctx)
	if err != nil {
		return nil, err
	}
	b := &Book{d: d, by: by, moves: moves, items: map[string]domain.Item{}, before: map[[2]string]int{}}
	for _, i := range items {
		b.items[i.ID] = i
		b.order = append(b.order, i.ID)
	}
	return b, nil
}

// Item is findById(stockItems, id, 'stock item').
func (b *Book) Item(id string) (domain.Item, error) {
	i, ok := b.items[id]
	if !ok {
		return i, errs.NotFound("stock item", id)
	}
	return i, nil
}

// Held is what a store holds of an item now.
func (b *Book) Held(villaID, itemID string) int { return domain.OnHand(b.moves, villaID, itemID, "") }

// Replay is the cost replay over the working set.
func (b *Book) Replay() domain.Replay {
	if b.replay == nil {
		r := domain.ReplayCost(b.moves)
		b.replay = &r
	}
	return *b.replay
}

// Average is the item's current average cost.
func (b *Book) Average(itemID string) int64 { return b.Replay().Average(itemID, "") }

// Push is the mock's push: a new movement numbered SM-1000+n, priced at the current average
// unless the fields say otherwise, dated today and booked in the actor's name.
func (b *Book) Push(ctx context.Context, m domain.Movement) (domain.Movement, error) {
	n, err := b.d.Repo.Next(ctx, "stockMovement")
	if err != nil {
		return m, err
	}
	m.ID, m.Number = fmt.Sprintf("sm-%d", n), fmt.Sprintf("SM-%d", 1000+n)
	if m.Kind != domain.Receipt && m.UnitCost == 0 {
		m.UnitCost = b.Average(m.ItemID)
	}
	if m.On == "" {
		m.On = b.d.today()
	}
	if m.By == "" {
		m.By = b.by
	}
	k := [2]string{m.VillaID, m.ItemID}
	if _, seen := b.before[k]; !seen {
		b.before[k] = b.Held(m.VillaID, m.ItemID)
	}
	if err := b.d.Repo.InsertMovement(ctx, m); err != nil {
		return m, err
	}
	b.moves = append(b.moves, m)
	b.added = append(b.added, m)
	b.replay = nil
	return m, nil
}

// Take is the mock's take: checks every line against the store before any of them moves.
func (b *Book) Take(ctx context.Context, villa Villa, lines []domain.Line, fields domain.Movement) ([]domain.Movement, error) {
	for _, l := range lines {
		item, err := b.Item(l.ItemID)
		if err != nil {
			return nil, err
		}
		if err := domain.CanTake(item, b.Held(villa.ID, l.ItemID), l.Quantity, villa.Name); err != nil {
			return nil, err
		}
	}
	out := make([]domain.Movement, 0, len(lines))
	for _, l := range lines {
		m := fields
		m.VillaID, m.ItemID, m.Quantity = villa.ID, l.ItemID, -l.Quantity
		pushed, err := b.Push(ctx, m)
		if err != nil {
			return nil, err
		}
		out = append(out, pushed)
	}
	return out, nil
}

// Replace swaps the working set's movements of a receipt for kept ones, as a correction does.
func (b *Book) Replace(receiptID string, keep func(m domain.Movement) bool) {
	out := b.moves[:0:0]
	for _, m := range b.moves {
		if m.ReceiptID == nil || *m.ReceiptID != receiptID || keep(m) {
			out = append(out, m)
		}
	}
	b.moves = out
	b.replay = nil
}

// Close reprices every item from the replay and announces the movements and any store that just
// reached its reorder level.
func (b *Book) Close(ctx context.Context) error {
	r := b.Replay()
	averages := map[string]int64{}
	for _, id := range b.order {
		if avg := r.Average(id, ""); avg != b.items[id].AverageCost {
			averages[id] = avg
		}
	}
	if err := b.d.Repo.SetAverages(ctx, averages); err != nil {
		return err
	}
	if len(b.added) == 0 {
		return nil
	}
	moved := inventory.StockMoved{Movements: make([]inventory.Movement, 0, len(b.added))}
	for _, m := range b.added {
		moved.Movements = append(moved.Movements, inventory.Movement{
			ID: m.ID, Number: m.Number, VillaID: m.VillaID, ItemID: m.ItemID, Kind: m.Kind, Quantity: m.Quantity, UnitCost: m.UnitCost, On: m.On,
			UnitID: m.UnitID, BookingID: m.BookingID, OrderID: m.OrderID, ReceiptID: m.ReceiptID, TransferID: m.TransferID, OtherVillaID: m.OtherVillaID, Reason: m.Reason,
		})
	}
	if err := b.d.emit(ctx, inventory.EventStockMoved, "stock_movement", b.added[0].ID, 1, moved); err != nil {
		return err
	}
	for k, before := range b.before {
		item := b.items[k[1]]
		after := b.Held(k[0], k[1])
		if item.Active && domain.IsLow(item, after) && !domain.IsLow(item, before) {
			low := inventory.StockLow{VillaID: k[0], ItemID: item.ID, ItemName: item.Name, OnHand: after, ReorderLevel: item.ReorderLevel}
			if err := b.d.emit(ctx, inventory.EventStockLow, "stock_store", k[0]+"/"+item.ID, 1, low); err != nil {
				return err
			}
		}
	}
	return nil
}

func ptr(s string) *string { return &s }
