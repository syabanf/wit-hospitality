package command

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/messaging/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Send queues a template or a free message to a stay's guest.
type Send struct{ Deps }

// Handle sends the message.
func (h Send) Handle(ctx context.Context, p auth.Principal, in domain.SendInput) (domain.Message, error) {
	var m domain.Message
	if err := h.sender(ctx, p); err != nil {
		return m, err
	}
	if err := domain.ValidateSend(in); err != nil {
		return m, err
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		b, _, err := h.stayInScope(ctx, p, in.BookingID)
		if err != nil {
			return err
		}
		f := fields{channel: in.Channel, language: in.Language}
		if in.TemplateKey == nil {
			body := strings.TrimSpace(in.Body)
			f.body = &body
		}
		if m, err = h.queue(ctx, b, in.TemplateKey, f, &p); err != nil {
			return err
		}
		what := "a message"
		if in.TemplateKey != nil {
			what = *in.TemplateKey
			s, _, err := h.Store.Settings(ctx)
			if err != nil {
				return err
			}
			if t, ok := s.Template(*in.TemplateKey); ok {
				what = t.Name
			}
		}
		g, err := h.Store.Guest(ctx, b.GuestID)
		if err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "message", EntityID: m.Number,
			Summary: fmt.Sprintf("Sent %s to %s on %s for %s", what, g.Name, domain.ChannelLabel[m.Channel], b.Code), After: map[string]any{"status": m.Status}})
	})
	return m, err
}

// Resend queues a failed message again, to the guest's current contact.
type Resend struct{ Deps }

// Handle resends the message.
func (h Resend) Handle(ctx context.Context, p auth.Principal, id string) (domain.Message, error) {
	var m domain.Message
	if err := h.sender(ctx, p); err != nil {
		return m, err
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if m, err = h.Store.Message(ctx, id); err != nil {
			return err
		}
		if err := domain.AssertResend(m); err != nil {
			return err
		}
		b, pl, err := h.stayInScope(ctx, p, m.BookingID)
		if err != nil {
			return err
		}
		g, err := h.Store.Guest(ctx, b.GuestID)
		if err != nil {
			return err
		}
		m.To = domain.AddressFor(g.Phone, g.Email, m.Channel)
		if err := h.deliver(ctx, &m); err != nil {
			return err
		}
		if err := h.Store.UpdateMessage(ctx, &m); err != nil {
			return err
		}
		if err := h.emit(ctx, m, pl.VillaID); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "message", EntityID: m.Number, Summary: fmt.Sprintf("Resent %s, attempt %d", m.Number, m.Attempts),
			Before: map[string]any{"status": domain.Failed}, After: map[string]any{"status": m.Status}})
	})
	return m, err
}

// SaveSettings replaces the templates, the pre-arrival days and the WiFi per villa.
type SaveSettings struct{ Deps }

// Handle saves the settings.
func (h SaveSettings) Handle(ctx context.Context, p auth.Principal, s domain.Settings) (domain.Settings, error) {
	if err := h.sender(ctx, p); err != nil {
		return s, err
	}
	if err := domain.ValidateSettings(s); err != nil {
		return s, err
	}
	if s.Wifi == nil {
		s.Wifi = map[string]string{}
	}
	enabled := func(list []domain.Template) map[string]any {
		out := map[string]any{}
		for _, t := range list {
			out[t.Key] = t.Enabled
		}
		return out
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		before, version, err := h.Store.Settings(ctx)
		if err != nil {
			return err
		}
		if _, err := h.Store.SaveSettings(ctx, s, version); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "message-settings", EntityID: "messaging",
			Summary: fmt.Sprintf("Changed the guest message templates; pre-arrival %d days before", s.PreArrivalDays),
			Before:  enabled(before.Templates), After: enabled(s.Templates)})
	})
	return s, err
}

// Sweep moves queued messages on with the provider and sends the time triggers that fell due, as
// the mock does on every read of the outbox.
type Sweep struct{ Deps }

// Handle runs the sweep.
func (h Sweep) Handle(ctx context.Context) error {
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.LockSweep(ctx); err != nil {
			return err
		}
		now := h.now()
		moving, err := h.Store.Moving(ctx)
		if err != nil {
			return err
		}
		for _, m := range moving {
			next := h.Provider.Track(m, now)
			if next == m.Status {
				continue
			}
			if (next == domain.Sent || next == domain.Delivered) && m.SentAt == nil {
				m.SentAt = &now
			}
			if next == domain.Delivered {
				m.DeliveredAt = &now
			}
			m.Status = next
			if err := h.Store.UpdateMessage(ctx, &m); err != nil {
				return err
			}
		}
		s, _, err := h.Store.Settings(ctx)
		if err != nil {
			return err
		}
		stays, err := h.Store.Stays(ctx)
		if err != nil {
			return err
		}
		for _, b := range stays {
			for _, key := range domain.DueTimeTriggers(domain.TriggerStay{Status: b.Status, CheckIn: b.CheckIn, CheckOut: b.CheckOut}, now, s.PreArrivalDays) {
				if err := skipUnknown(h.fire(ctx, b, key, nil, true)); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

// Triggers are the reactions to reservation and billing events. They run inside the projector's
// transaction. A stay, guest or unit messaging has no copy of yet skips the message rather than
// stopping the relay on the event.
type Triggers struct{ Deps }

func skipUnknown(err error) error {
	if errs.HasCode(err, errs.CodeNotFound) {
		return nil
	}
	return err
}

// OnStatus fires the template of a booking status: confirmation (not for a group's stay), welcome,
// thank you with the e-invoice.
func (h Triggers) OnStatus(ctx context.Context, bookingID, status string) error {
	key, ok := domain.StatusTrigger[status]
	if !ok {
		return nil
	}
	b, err := h.Store.Stay(ctx, bookingID)
	if err != nil {
		return skipUnknown(err)
	}
	if key == "booking_confirmed" && b.GroupID != "" {
		return nil
	}
	return skipUnknown(h.fire(ctx, b, key, nil, true))
}

// OnLink sends the payment link, every time one opens.
func (h Triggers) OnLink(ctx context.Context, bookingID, token string, amount int64) error {
	b, err := h.Store.Stay(ctx, bookingID)
	if err != nil {
		return skipUnknown(err)
	}
	return skipUnknown(h.fire(ctx, b, "payment_link", domain.Vars{"link": domain.PayURL(token), "amount": amount}, false))
}

// OnPaid sends the receipt, every time a payment lands.
func (h Triggers) OnPaid(ctx context.Context, bookingID string, amount int64) error {
	b, err := h.Store.Stay(ctx, bookingID)
	if err != nil {
		return skipUnknown(err)
	}
	return skipUnknown(h.fire(ctx, b, "payment_received", domain.Vars{"amount": amount}, false))
}

// Invoice answers the public e-invoice link: the stay behind the token, rendered by billing.
type Invoice struct{ Deps }

// Handle renders the invoice; a forged or draft token is NOT_FOUND.
func (h Invoice) Handle(ctx context.Context, token string) (json.RawMessage, error) {
	b, err := h.Store.StayByInvoiceToken(ctx, token)
	if err != nil {
		return nil, err
	}
	if b == nil || b.Status == "draft" {
		return nil, errs.NotFound("invoice", token)
	}
	return h.Billing.Invoice(ctx, b.ID)
}
