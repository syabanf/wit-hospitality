package command

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	"github.com/syabanf/wit-hospitality/api/internal/services"
	"github.com/syabanf/wit-hospitality/api/internal/services/domain"
)

// placeOrder is the mock's placeOrder: staff and guests order through the same rules, a stay in
// house or arriving soon, items served at that time, free items only with permission.
func (d Deps) placeOrder(ctx context.Context, actor auth.Principal, placedBy string, in domain.OrderInput, stay reservation.Stay) (domain.ServiceOrder, error) {
	today := d.today()
	if !domain.OrderableStay(stay.Status, stay.CheckIn, today) {
		return domain.ServiceOrder{}, errs.New(domain.CodeOrderNoStay, fmt.Sprintf("%s is not in house or arriving within %d days; room service is for staying guests.", stay.Code, domain.OrderArrivalDays))
	}
	if in.RequestedOn > stay.CheckOut {
		return domain.ServiceOrder{}, errs.New(domain.CodeOrderNoStay, fmt.Sprintf("%s checks out on %s; pick a time during the stay.", stay.Code, stay.CheckOut))
	}
	pl, err := d.place(ctx, stay.UnitID)
	if err != nil {
		return domain.ServiceOrder{}, err
	}
	now, at := d.minute(), int(in.RequestedAt)
	lines := make([]domain.OrderLine, 0, len(in.Lines))
	for _, l := range in.Lines {
		item, err := d.Repo.MenuItem(ctx, l.ItemID)
		if err != nil {
			return domain.ServiceOrder{}, err
		}
		if item.VillaID != pl.Villa.ID {
			return domain.ServiceOrder{}, errs.New(domain.CodeItemUnavailable, fmt.Sprintf("%s is not on the %s menu.", item.Name, pl.Villa.Name))
		}
		if err := domain.ItemProblem(item, in.RequestedOn, at, today, now); err != nil {
			return domain.ServiceOrder{}, err
		}
		lines = append(lines, domain.OrderLine{ItemID: item.ID, Name: item.Name, Category: item.Category, Unit: item.Unit, Price: item.Price,
			Quantity: l.Quantity, CostPrice: item.CostPrice, PartnerID: item.PartnerID, Comp: placedBy == "staff" && l.Comp})
	}
	comped := slices.ContainsFunc(lines, func(l domain.OrderLine) bool { return l.Comp })
	if comped {
		ok, err := d.can(ctx, actor, "services", "comp")
		if err != nil {
			return domain.ServiceOrder{}, err
		}
		if !ok {
			return domain.ServiceOrder{}, errs.New(domain.CodeCompForbidden, fmt.Sprintf("%s cannot give items for free. Ask a villa manager.", rbac.RoleLabel[actor.Role]))
		}
	}
	if in.DiscountPct > 0 {
		if placedBy == "guest" {
			return domain.ServiceOrder{}, errs.Forbidden("Guests order at menu prices.")
		}
		limit, err := d.Billing.DiscountLimitPct(ctx)
		if errs.HasCode(err, CodeNotAvailable) {
			limit, err = DefaultDiscountLimitPct, nil
		}
		if err != nil {
			return domain.ServiceOrder{}, err
		}
		approve, err := d.can(ctx, actor, "booking", "approve")
		if err != nil {
			return domain.ServiceOrder{}, err
		}
		if in.DiscountPct > limit && !approve {
			return domain.ServiceOrder{}, errs.New(domain.CodeDiscountLimit, fmt.Sprintf("%s%% off is past the %s%% limit. Ask a villa manager to give it.", domain.Quantity(in.DiscountPct), domain.Quantity(limit)))
		}
	}
	n, err := d.Repo.Next(ctx, "order")
	if err != nil {
		return domain.ServiceOrder{}, err
	}
	note := strings.TrimSpace(in.Note)
	o := domain.ServiceOrder{
		ID: "so-" + strconv.FormatInt(n, 10), Number: "SO-" + strconv.FormatInt(700+n, 10), BookingID: stay.ID, UnitID: stay.UnitID, VillaID: pl.Villa.ID,
		Lines: lines, Note: note, RequestedOn: in.RequestedOn, RequestedAt: at, Priority: in.Priority, Status: domain.OrderNew,
		PlacedBy: placedBy, CreatedOn: today, DiscountPct: in.DiscountPct, CostTransactionIDs: []string{},
		History: []domain.OrderEvent{{Kind: "placed", By: actor.Name, At: d.stamp(), Note: note}},
	}
	if o.Priority == "" {
		o.Priority = "normal"
	}
	if in.DiscountPct > 0 {
		o.DiscountReason = strings.TrimSpace(in.DiscountReason)
	}
	if comped {
		o.CompReason = strings.TrimSpace(in.CompReason)
	}
	if err := d.Repo.InsertOrder(ctx, &o); err != nil {
		return o, err
	}
	verb := "Ordered"
	if placedBy == "guest" {
		verb = "Guest ordered"
	}
	if err := d.record(ctx, actor, audit.Line{Action: audit.Create, Entity: "service-order", EntityID: o.Number,
		Summary: fmt.Sprintf("%s %s for %s", verb, domain.OrderSummary(o.Lines), stay.Code), After: map[string]any{"charge": o.Totals().Charge}}); err != nil {
		return o, err
	}
	return o, d.emit(ctx, services.EventOrderPlaced, "service_order", o.ID, o.Version, d.orderRecord(o, pl.Villa))
}

func (d Deps) orderRecord(o domain.ServiceOrder, v domain.Villa) services.OrderRecord {
	return services.OrderRecord{ID: o.ID, VillaID: v.ID, LocationID: v.LocationID, BookingID: o.BookingID, Order: mustJSON(o)}
}

// PlaceOrder is POST /service-orders: an order from the desk.
type PlaceOrder struct{ Deps }

// Handle places the order as the signed-in user.
func (h PlaceOrder) Handle(ctx context.Context, p auth.Principal, in domain.OrderInput) (domain.ServiceOrder, error) {
	if err := h.Authz.Require(ctx, p.Role, servicesCreate...); err != nil {
		return domain.ServiceOrder{}, err
	}
	if err := domain.ValidateOrder(in); err != nil {
		return domain.ServiceOrder{}, err
	}
	var out domain.ServiceOrder
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		stay, err := h.Stays.Stay(ctx, in.BookingID)
		if err != nil {
			return err
		}
		pl, err := h.place(ctx, stay.UnitID)
		if err != nil {
			return err
		}
		if err := inScope(p, pl.Villa); err != nil {
			return err
		}
		out, err = h.placeOrder(ctx, p, "staff", in, stay)
		return err
	})
	return out, err
}

// StepOrder is POST /service-orders/{id}/accept, prepare, deliver, cancel and void.
type StepOrder struct{ Deps }

// Handle moves the order on the board. Delivery publishes the priced lines for billing,
// inventory and finance; a void on the delivery's business day publishes their reversal.
func (h StepOrder) Handle(ctx context.Context, p auth.Principal, id, to, note string) (domain.ServiceOrder, error) {
	if err := h.Authz.Require(ctx, p.Role, servicesEdit...); err != nil {
		return domain.ServiceOrder{}, err
	}
	var out domain.ServiceOrder
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		o, err := h.Repo.Order(ctx, id)
		if err != nil {
			return err
		}
		v, err := h.villa(ctx, o.VillaID)
		if err != nil {
			return err
		}
		if err := inScope(p, v); err != nil {
			return err
		}
		if err := o.CheckStep(to, note); err != nil {
			return err
		}
		if to == domain.OrderVoided {
			if err := h.checkVoid(ctx, o); err != nil {
				return err
			}
		}
		from := o.Status
		o.Step(to, note, p.Name, h.stamp(), h.today(), h.minute())
		if err := h.Repo.UpdateOrder(ctx, &o); err != nil {
			return err
		}
		out = o
		if err := h.record(ctx, p, audit.Line{Action: audit.Status, Entity: "service-order", EntityID: o.Number,
			Summary: domain.OrderStatusLabel[to] + " " + o.Number, Before: map[string]any{"status": from}, After: map[string]any{"status": to}}); err != nil {
			return err
		}
		if err := h.emit(ctx, services.EventOrderStatusChanged, "service_order", o.ID, o.Version,
			services.OrderStatusChanged{OrderRecord: h.orderRecord(o, v), From: from, To: to, Note: strings.TrimSpace(note)}); err != nil {
			return err
		}
		switch to {
		case domain.OrderDelivered:
			billed, err := h.billed(ctx, o, v, *o.DeliveredOn, "")
			if err != nil {
				return err
			}
			billed.By, billed.ByID, billed.ByRole = p.Name, p.UserID, string(p.Role)
			return h.emit(ctx, services.EventOrderDelivered, "service_order", o.ID, o.Version, billed)
		case domain.OrderVoided:
			billed, err := h.billed(ctx, o, v, h.today(), strings.TrimSpace(note))
			if err != nil {
				return err
			}
			billed.By, billed.ByID, billed.ByRole = p.Name, p.UserID, string(p.Role)
			return h.emit(ctx, services.EventOrderVoided, "service_order", o.ID, o.Version, billed)
		}
		return nil
	})
	return out, err
}

// checkVoid reads the business date and the order's money from billing; without billing the
// business date is today.
func (h StepOrder) checkVoid(ctx context.Context, o domain.ServiceOrder) error {
	day, err := h.Billing.BusinessDate(ctx)
	if errs.HasCode(err, CodeNotAvailable) {
		day, err = h.today(), nil
	}
	if err != nil {
		return err
	}
	statusOf, pm, err := h.payments(ctx, o.BookingID)
	if err != nil {
		return err
	}
	bills, err := h.Repo.Bills(ctx, o.ID)
	if err != nil {
		return err
	}
	return o.CheckVoid(day, domain.PayState(o, statusOf(o.PaymentID)), pm.Rebated[o.ID] > 0, bills)
}

// billed prices a delivered order's lines for the folio, the stock and the partner bills.
func (d Deps) billed(ctx context.Context, o domain.ServiceOrder, v domain.Villa, on, reason string) (services.OrderBilled, error) {
	t := o.Totals()
	b := services.OrderBilled{
		OrderID: o.ID, Number: o.Number, BookingID: o.BookingID, UnitID: o.UnitID, VillaID: v.ID, LocationID: v.LocationID,
		PlacedBy: o.PlacedBy, On: on, DiscountPct: o.DiscountPct, DiscountReason: o.DiscountReason, CompReason: o.CompReason,
		Totals: services.Totals{Gross: t.Gross, Comp: t.Comp, Discount: t.Discount, Charge: t.Charge, Cost: t.Cost, Margin: t.Margin},
		Lines:  make([]services.BilledLine, len(o.Lines)), Codes: []services.CodeAmount{}, Revenue: []services.CategoryAmount{},
		PartnerCosts: []services.PartnerCost{}, Reason: reason,
	}
	if o.DeliveredAt != nil {
		b.At = *o.DeliveredAt
	}
	for i, l := range o.Lines {
		b.Lines[i] = services.BilledLine{ItemID: l.ItemID, Name: l.Name, Category: l.Category, TransactionCode: domain.CategoryCode[l.Category],
			RevenueCategoryID: domain.RevenueCategory[l.Category], Unit: l.Unit, Quantity: l.Quantity, UnitPrice: l.Price, Amount: domain.LineAmount(l),
			Comp: l.Comp, PartnerID: l.PartnerID, UnitCost: l.CostPrice, Cost: domain.LineCost(l)}
	}
	for _, s := range domain.CodeSplit(o) {
		b.Codes = append(b.Codes, services.CodeAmount{Code: s.Key, Amount: s.Amount})
	}
	for _, s := range domain.RevenueSplit(o) {
		b.Revenue = append(b.Revenue, services.CategoryAmount{CategoryID: s.Key, Amount: s.Amount})
	}
	for _, c := range domain.PartnerCosts(o) {
		name := "Partner"
		if partner, err := d.Repo.Partner(ctx, c.PartnerID); err == nil {
			name = partner.Name
		} else if !errs.HasCode(err, errs.CodeNotFound) {
			return b, err
		}
		cost := services.PartnerCost{PartnerID: c.PartnerID, PartnerName: name, CategoryID: services.PartnerCostCategory, Amount: c.Amount, ItemIDs: []string{}}
		for _, l := range c.Lines {
			cost.ItemIDs = append(cost.ItemIDs, l.ItemID)
		}
		b.PartnerCosts = append(b.PartnerCosts, cost)
	}
	return b, nil
}

// AssignOrder is PATCH /service-orders/{id} with { assignee }.
type AssignOrder struct{ Deps }

// Handle names who takes the order.
func (h AssignOrder) Handle(ctx context.Context, p auth.Principal, id, assignee string) (domain.ServiceOrder, error) {
	if err := h.Authz.Require(ctx, p.Role, servicesEdit...); err != nil {
		return domain.ServiceOrder{}, err
	}
	assignee = strings.TrimSpace(assignee)
	if len([]rune(assignee)) < 2 {
		return domain.ServiceOrder{}, errs.Invalid("assignee", "Enter who takes it.")
	}
	var out domain.ServiceOrder
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		o, err := h.Repo.Order(ctx, id)
		if err != nil {
			return err
		}
		v, err := h.villa(ctx, o.VillaID)
		if err != nil {
			return err
		}
		if err := inScope(p, v); err != nil {
			return err
		}
		o.Assignee = assignee
		o.History = append(o.History, domain.OrderEvent{Kind: "assigned", By: p.Name, At: h.stamp(), Note: assignee})
		if err := h.Repo.UpdateOrder(ctx, &o); err != nil {
			return err
		}
		out = o
		return h.emit(ctx, services.EventOrderAssigned, "service_order", o.ID, o.Version, h.orderRecord(o, v))
	})
	return out, err
}

// BillDecided follows finance's cash_out.decided for the partner bills of a delivered order: it
// keeps each bill's status for the void check and lists the bills on the order as
// costTransactionIds, as the mock's delivery does. It runs in the projector's transaction; other
// sources and orders services does not hold are skipped.
type BillDecided struct{ Deps }

// Handle records the bill and refreshes the order's costTransactionIds.
func (h BillDecided) Handle(ctx context.Context, e services.CashOutDecided) error {
	if e.SourceType != services.SourcePartnerBill {
		return nil
	}
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		o, err := h.Repo.Order(ctx, e.SourceID)
		if errs.HasCode(err, errs.CodeNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := h.Repo.SaveBill(ctx, o.ID, domain.CostBill{TransactionID: e.TransactionID, PartnerID: e.PartnerID, Status: e.Status, Version: e.Version}); err != nil {
			return err
		}
		bills, err := h.Repo.Bills(ctx, o.ID)
		if err != nil {
			return err
		}
		ids := domain.CostTransactionIDs(o, bills)
		if slices.Equal(ids, o.CostTransactionIDs) {
			return nil
		}
		o.CostTransactionIDs = ids
		return h.Repo.UpdateOrder(ctx, &o)
	})
}

// OrdersPaid follows billing's payment.recorded: each order the payment settles points at it, as
// the mock's markOrdersPaid does, so the board reads it paid. It runs in the projector's
// transaction; an order services does not hold is skipped.
type OrdersPaid struct{ Deps }

// Handle marks the payment's orders paid.
func (h OrdersPaid) Handle(ctx context.Context, e billing.PaymentRecorded) error {
	if e.Kind == "refund" {
		return nil
	}
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		for _, id := range e.OrderIDs {
			o, err := h.Repo.Order(ctx, id)
			if errs.HasCode(err, errs.CodeNotFound) {
				continue
			}
			if err != nil {
				return err
			}
			if domain.MarkPaid(&o, e.PaymentID, e.Number, e.Method, e.RecordedBy, h.stamp()) {
				if err := h.Repo.UpdateOrder(ctx, &o); err != nil {
					return err
				}
			}
		}
		return nil
	})
}
