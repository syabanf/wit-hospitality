package postgres

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
)

// seedRelations inserts the complaints, incidents, safe boxes and box rentals with their dates
// moved and a saved event each. The postings their money made are already in billing's seed, so
// no folio posting is requested again. The seed runs before property's events reach guest's villa
// copy, so the events carry no location.
func seedRelations(ctx context.Context, d *db.DB, data SeedData, n shifter, emit func(eventType, aggregateType, id string, payload any) error) error {
	repo := Repo{DB: d}
	saved := func(eventType, aggregateType, id, villaID string, record any) error {
		raw, err := json.Marshal(record)
		if err != nil {
			return err
		}
		return emit(eventType, aggregateType, id, guest.RecordSaved{Record: raw, VillaID: villaID})
	}
	for _, c := range data.Complaints {
		c.ReceivedAt = n.day(c.ReceivedAt)
		for k := range c.Timeline {
			c.Timeline[k].At = n.day(c.Timeline[k].At)
		}
		if c.Resolution != nil {
			c.Resolution.At = n.day(c.Resolution.At)
		}
		if c.Compensation != nil {
			c.Compensation.DecidedAt = n.ptr(c.Compensation.DecidedAt)
		}
		if c.Links == nil {
			c.Links = []domain.Link{}
		}
		if err := repo.InsertComplaint(ctx, &c); err != nil {
			return fmt.Errorf("seed complaint %s: %w", c.ID, err)
		}
		if err := saved(guest.EventComplaintSaved, "complaint", c.ID, c.VillaID, c); err != nil {
			return err
		}
	}
	for _, i := range data.Incidents {
		i.OccurredAt, i.Attachments = n.day(i.OccurredAt), n.photos(i.Attachments)
		for k := range i.Timeline {
			i.Timeline[k].At = n.day(i.Timeline[k].At)
		}
		if i.Charge != nil {
			i.Charge.At = n.day(i.Charge.At)
		}
		if i.SignOff != nil {
			i.SignOff.At = n.day(i.SignOff.At)
		}
		if i.People == nil {
			i.People = []domain.IncidentPerson{}
		}
		if err := repo.InsertIncident(ctx, &i); err != nil {
			return fmt.Errorf("seed incident %s: %w", i.ID, err)
		}
		if err := saved(guest.EventIncidentSaved, "incident", i.ID, i.VillaID, i); err != nil {
			return err
		}
	}
	for _, b := range data.SafeBoxes {
		if err := repo.InsertSafeBox(ctx, &b); err != nil {
			return fmt.Errorf("seed safe box %s: %w", b.ID, err)
		}
		if err := saved(guest.EventSafeBoxSaved, "safe_box", b.ID, b.VillaID, b); err != nil {
			return err
		}
	}
	for _, r := range data.BoxRentals {
		r.OpenedAt, r.ClosedAt = n.day(r.OpenedAt), n.ptr(r.ClosedAt)
		for k := range r.Log {
			r.Log[k].At = n.day(r.Log[k].At)
		}
		if err := repo.InsertBoxRental(ctx, &r); err != nil {
			return fmt.Errorf("seed box rental %s: %w", r.ID, err)
		}
		if err := saved(guest.EventBoxRentalSaved, "box_rental", r.ID, r.VillaID, r); err != nil {
			return err
		}
	}
	return nil
}
