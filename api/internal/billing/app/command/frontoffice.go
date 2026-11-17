package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Card holds: a pre-authorization on the guest's card stands as the stay's security deposit. A
// hold moves no money; a capture is a card payment on the room part of the folio.

// CardHolds takes, captures and releases card holds. Each needs payments/create.
type CardHolds struct{ Deps }

func (h CardHolds) hold(ctx context.Context, p auth.Principal, id string) (domain.PreAuth, domain.Booking, Place, error) {
	hold, err := get[domain.PreAuth](ctx, h.Deps, PreAuths, id, "card hold")
	if err != nil {
		return hold, domain.Booking{}, Place{}, err
	}
	b, pl, err := h.stayInScope(ctx, p, hold.BookingID)
	return hold, b, pl, err
}

func (h CardHolds) save(ctx context.Context, hold domain.PreAuth, pl Place) error {
	return h.Store.Put(ctx, PreAuths, Row{ID: hold.ID, BookingID: hold.BookingID, VillaID: pl.VillaID, LocationID: pl.LocationID, Doc: hold})
}

// Create takes a hold through the gateway.
func (h CardHolds) Create(ctx context.Context, p auth.Principal, in domain.PreAuthInput) (domain.PreAuth, error) {
	if err := h.Authz.Require(ctx, p.Role, paymentsCreate...); err != nil {
		return domain.PreAuth{}, err
	}
	var out domain.PreAuth
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		b, pl, err := h.stayInScope(ctx, p, in.BookingID)
		if err != nil {
			return err
		}
		if err := domain.ValidatePreAuth(in, h.today()); err != nil {
			return err
		}
		holds, err := docs[domain.PreAuth](h.Store.ByBooking(ctx, PreAuths, b.ID))
		if err != nil {
			return err
		}
		if err := domain.HoldProblem(b, holds); err != nil {
			return err
		}
		n, err := h.Store.Next(ctx, "preAuth")
		if err != nil {
			return err
		}
		out = domain.PreAuth{ID: fmt.Sprintf("pa-%d", n), Number: fmt.Sprintf("PA-%d", 1000+n), BookingID: b.ID, Amount: int64(in.Amount), Brand: in.Brand,
			Last4: in.Last4, ApprovalCode: strings.TrimSpace(in.ApprovalCode), ExpiresOn: in.ExpiresOn, Status: domain.HoldActive, TakenBy: p.Name, TakenAt: h.stamp()}
		if out.ApprovalCode, err = h.Gateway.Authorize(ctx, out, n); err != nil {
			return err
		}
		if err := h.save(ctx, out, pl); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "pre-auth", EntityID: out.Number,
			Summary: fmt.Sprintf("Held %s on %s ending %s for %s, until %s", domain.Rupiah(out.Amount), domain.BrandLabel[out.Brand], out.Last4, b.Code, out.ExpiresOn)})
	})
	return out, err
}

// CaptureResult is the answer of POST /pre-auths/{id}/capture.
type CaptureResult struct {
	PreAuth domain.PreAuth `json:"preAuth"`
	Payment domain.Payment `json:"payment"`
}

// Capture takes part or all of a hold against the room balance as a paid card payment, and lets
// the rest of the hold go.
func (h CardHolds) Capture(ctx context.Context, p auth.Principal, id string, amount float64) (CaptureResult, error) {
	if err := h.Authz.Require(ctx, p.Role, paymentsCreate...); err != nil {
		return CaptureResult{}, err
	}
	var out CaptureResult
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		hold, b, pl, err := h.hold(ctx, p, id)
		if err != nil {
			return err
		}
		f, err := h.folio(ctx, b, false)
		if err != nil {
			return err
		}
		if err := hold.CaptureProblem(amount, f.Due.Room, h.today()); err != nil {
			return err
		}
		taken := int64(amount)
		if err := h.Gateway.Capture(ctx, hold, taken); err != nil {
			return err
		}
		policy, err := h.policy(ctx)
		if err != nil {
			return err
		}
		pay, err := h.newPayment(ctx, p, b, pl, domain.Payment{Kind: "balance", Method: "card", Amount: taken, Status: "paid", Reference: hold.ApprovalCode,
			Note: "Captured from " + hold.Number, PaidOn: ptr(h.today()), GatewayFee: domain.GatewayFee("card", taken, policy),
			History: []domain.PaymentEvent{{Kind: "paid", By: p.Name, At: h.stamp(), Note: "Card hold captured"}}})
		if err != nil {
			return err
		}
		if err := h.recorded(ctx, p, b, pl, pay, nil); err != nil {
			return err
		}
		hold.Status, hold.Captured, hold.PaymentID, hold.ClosedBy, hold.ClosedAt = domain.HoldCaptured, taken, &pay.ID, &p.Name, ptr(h.stamp())
		if err := h.save(ctx, hold, pl); err != nil {
			return err
		}
		out = CaptureResult{PreAuth: hold, Payment: pay}
		return h.record(ctx, p, audit.Line{Action: audit.Status, Entity: "pre-auth", EntityID: hold.Number,
			Summary: fmt.Sprintf("Captured %s of %s on %s", domain.Rupiah(taken), hold.Number, b.Code)})
	})
	return out, err
}

// Release lets a hold go without taking money; an expired hold may be released.
func (h CardHolds) Release(ctx context.Context, p auth.Principal, id string) (domain.PreAuth, error) {
	if err := h.Authz.Require(ctx, p.Role, paymentsCreate...); err != nil {
		return domain.PreAuth{}, err
	}
	var out domain.PreAuth
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		hold, b, pl, err := h.hold(ctx, p, id)
		if err != nil {
			return err
		}
		if err := hold.ClosedProblem(); err != nil {
			return err
		}
		if err := h.Gateway.Release(ctx, hold); err != nil {
			return err
		}
		hold.Status, hold.ClosedBy, hold.ClosedAt = domain.HoldReleased, &p.Name, ptr(h.stamp())
		if err := h.save(ctx, hold, pl); err != nil {
			return err
		}
		out = hold
		return h.record(ctx, p, audit.Line{Action: audit.Status, Entity: "pre-auth", EntityID: hold.Number, Summary: fmt.Sprintf("Released %s on %s", hold.Number, b.Code)})
	})
	return out, err
}

// Log book: the desk's shift notes, with follow-ups the next shift acknowledges.

// LogBook writes, acknowledges and closes log book entries. Each needs booking/edit.
type LogBook struct{ Deps }

var bookingEditNeed = rbac.Need{Module: "booking", Action: "edit"}

func (h LogBook) entry(ctx context.Context, p auth.Principal, id string) (domain.LogEntry, Place, error) {
	e, err := get[domain.LogEntry](ctx, h.Deps, LogEntries, id, "log entry")
	if err != nil || e.VillaID == nil {
		return e, Place{}, err
	}
	pl, err := h.Store.Villa(ctx, *e.VillaID)
	if err != nil {
		return e, pl, err
	}
	return e, pl, inScope(p, pl)
}

func (d Deps) saveLog(ctx context.Context, e domain.LogEntry, pl Place) error {
	ref := ""
	if e.ShiftID != nil {
		ref = *e.ShiftID
	}
	return d.Store.Put(ctx, LogEntries, Row{ID: e.ID, VillaID: pl.VillaID, LocationID: pl.LocationID, Ref: ref, Doc: e})
}

// newLog numbers an entry written now by p.
func (d Deps) newLog(ctx context.Context, p auth.Principal, category, text string) (domain.LogEntry, error) {
	n, err := d.Store.Next(ctx, "logEntry")
	if err != nil {
		return domain.LogEntry{}, err
	}
	at := d.stamp()
	shift, date := domain.ShiftOf(at)
	return domain.LogEntry{ID: fmt.Sprintf("log-%d", n), At: at, Date: date, Shift: shift, Author: p.Name, AuthorID: p.UserID, Category: category, Text: strings.TrimSpace(text)}, nil
}

// linkLabel names what an entry points at; "" when it does not exist.
func (h LogBook) linkLabel(ctx context.Context, l domain.LogLink) (string, error) {
	switch l.Kind {
	case "booking":
		b, err := h.stay(ctx, l.ID)
		if errs.HasCode(err, errs.CodeNotFound) {
			return "", nil
		}
		return b.Code, err
	case "unit":
		pl, err := h.Store.Place(ctx, l.ID)
		return pl.UnitCode, err
	case "guest":
		return h.guestName(ctx, l.ID), nil
	}
	return "", nil
}

// Write adds an entry.
func (h LogBook) Write(ctx context.Context, p auth.Principal, in domain.LogInput) (domain.LogEntry, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingEditNeed); err != nil {
		return domain.LogEntry{}, err
	}
	var out domain.LogEntry
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		f := domain.ValidateLog(in)
		var pl Place
		if in.VillaID != nil && *in.VillaID == "" {
			in.VillaID = nil
		}
		if in.VillaID != nil {
			var err error
			if pl, err = h.Store.Villa(ctx, *in.VillaID); err != nil {
				return err
			}
			if pl.VillaName == "" {
				f.Add("villaId", "Pick a property.")
			} else if err := inScope(p, pl); err != nil {
				return err
			}
		}
		var link *domain.LogLink
		if in.Link != nil && !f.Has("link") {
			label, err := h.linkLabel(ctx, *in.Link)
			if err != nil {
				return err
			}
			if label == "" {
				f.Add("link", "That booking, room or guest was not found.")
			}
			link = &domain.LogLink{Kind: in.Link.Kind, ID: in.Link.ID, Label: label}
		}
		if err := f.Err(); err != nil {
			return err
		}
		e, err := h.newLog(ctx, p, in.Category, in.Text)
		if err != nil {
			return err
		}
		e.VillaID, e.Link, e.FollowUp = in.VillaID, link, in.FollowUp
		if err := h.saveLog(ctx, e, pl); err != nil {
			return err
		}
		out = e
		summary := fmt.Sprintf("Logged %s note", strings.ToLower(domain.LogCategoryLabel[e.Category]))
		if e.FollowUp {
			summary += ", follow-up"
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "log-entry", EntityID: e.ID, Summary: summary})
	})
	return out, err
}

// Acknowledge records that the next shift read a follow-up.
func (h LogBook) Acknowledge(ctx context.Context, p auth.Principal, id string) (domain.LogEntry, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingEditNeed); err != nil {
		return domain.LogEntry{}, err
	}
	var out domain.LogEntry
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		e, pl, err := h.entry(ctx, p, id)
		if err != nil {
			return err
		}
		if err := e.AcknowledgeProblem(p.UserID); err != nil {
			return err
		}
		e.AcknowledgedBy, e.AcknowledgedAt = &p.Name, ptr(h.stamp())
		if err := h.saveLog(ctx, e, pl); err != nil {
			return err
		}
		out = e
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "log-entry", EntityID: e.ID, Summary: "Acknowledged the note of " + e.Author})
	})
	return out, err
}

// Done closes a follow-up; one nobody acknowledged is acknowledged with it.
func (h LogBook) Done(ctx context.Context, p auth.Principal, id, note string) (domain.LogEntry, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingEditNeed); err != nil {
		return domain.LogEntry{}, err
	}
	var out domain.LogEntry
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		e, pl, err := h.entry(ctx, p, id)
		if err != nil {
			return err
		}
		if err := e.DoneProblem(note); err != nil {
			return err
		}
		now := h.stamp()
		if e.AcknowledgedBy == nil {
			e.AcknowledgedBy, e.AcknowledgedAt = &p.Name, &now
		}
		e.DoneBy, e.DoneAt, e.DoneNote = &p.Name, &now, strings.TrimSpace(note)
		if err := h.saveLog(ctx, e, pl); err != nil {
			return err
		}
		out = e
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "log-entry", EntityID: e.ID, Summary: fmt.Sprintf("Marked the note of %s done", e.Author)})
	})
	return out, err
}

// mayCloseOverDiscrepancies is the restriction override rule: a villa manager or booking/approve.
func (d Deps) mayCloseOverDiscrepancies(ctx context.Context, p auth.Principal) (bool, error) {
	if p.Role == "manager" {
		return true, nil
	}
	return d.can(ctx, p, "booking", "approve")
}
