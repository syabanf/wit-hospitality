package bootstrap

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"slices"

	billingpg "github.com/syabanf/wit-hospitality/api/internal/billing/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/channel"
	channelpg "github.com/syabanf/wit-hospitality/api/internal/channel/adapters/postgres"
	housekeepingpg "github.com/syabanf/wit-hospitality/api/internal/housekeeping/adapters/postgres"
	ownerspg "github.com/syabanf/wit-hospitality/api/internal/owners/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/platform/config"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/snapshot"
	"github.com/syabanf/wit-hospitality/api/internal/property"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	reservationpg "github.com/syabanf/wit-hospitality/api/internal/reservation/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/services"
)

// catchUp is a copy a consumer keeps from another context's events whose table came with a later
// migration than the events that feed it, so on an already seeded database it starts empty.
type catchUp struct {
	consumer, eventType, source string
}

// catchUps lists those copies. Add a line when a migration adds a copy fed only by events, and give
// the source context a snapshot for the event type.
var catchUps = []catchUp{
	{ownerspg.ConsumerStays, reservation.EventGroupSaved, Reservation},               // owners 00002_groups
	{billingpg.ConsumerCatalog, property.EventLocationUpdated, Property},             // billing catalog on a database seeded before billing
	{billingpg.ConsumerCatalog, property.EventVillaUpdated, Property},                // billing catalog on a database seeded before billing
	{billingpg.ConsumerCatalog, property.EventGroupUpdated, Property},                // billing 00003_invoice_names
	{billingpg.ConsumerCatalog, property.EventUnitUpdated, Property},                 // cat_units.group_id
	{billingpg.ConsumerChannel, channel.EventAccountUpdated, Channel},                // cat_accounts
	{billingpg.ConsumerServices, services.EventRequestSaved, Services},               // rm_requests
	{reservationpg.ConsumerCatalog, property.EventVillaUpdated, Property},            // reservation 00003_catalog_profile, 00005_hospitality
	{reservationpg.ConsumerCatalog, property.EventUnitUpdated, Property},             // reservation 00003_catalog_profile
	{channelpg.ConsumerCatalog, property.EventVillaUpdated, Property},                // channel 00002_site_profile
	{channelpg.ConsumerCatalog, property.EventUnitUpdated, Property},                 // channel 00002_site_profile
	{reservationpg.ConsumerCatalog, property.EventGroupUpdated, Property},            // reservation 00004_whole_villa (villas too, above)
	{housekeepingpg.ConsumerCatalog, property.EventVillaUpdated, Property},           // housekeeping 00004_stayover
	{housekeepingpg.ConsumerCatalog, property.EventGroupUpdated, Property},           // housekeeping 00004_stayover
	{housekeepingpg.ConsumerReservation, reservation.EventBookingSaved, Reservation}, // housekeeping 00005_service_window
}

// catchUpFill returns App.Fill for the copies whose consumer runs here. Each reads its source in
// process when the source context runs here (local), else over HTTP to the source's URL
// (RESERVATION_URL, PROPERTY_URL, CHANNEL_URL, SERVICES_URL), and replays the records through the
// consumer's own handler. Nil when no copy here has a source to ask.
func catchUpFill(cfg config.Config, log *slog.Logger, proj *projector.Projector, local snapshot.Sources) func(context.Context) error {
	urls := map[string]string{Reservation: cfg.ReservationURL, Property: os.Getenv("PROPERTY_URL"), Channel: os.Getenv("CHANNEL_URL"), Services: os.Getenv("SERVICES_URL")}
	type job struct {
		catchUp
		from snapshot.Source
	}
	var jobs []job
	consumers := proj.Consumers()
	for _, c := range catchUps {
		if !slices.Contains(consumers, c.consumer) {
			continue
		}
		switch {
		case local[c.eventType] != nil:
			jobs = append(jobs, job{c, local})
		case urls[c.source] != "":
			jobs = append(jobs, job{c, snapshot.HTTP{BaseURL: urls[c.source], Token: cfg.InternalToken}})
		default:
			log.Warn("no source to catch a copy up from", slog.String("consumer", c.consumer), slog.String("event", c.eventType))
		}
	}
	if len(jobs) == 0 {
		return nil
	}
	return func(ctx context.Context) error {
		var failed []error
		for _, j := range jobs {
			records, err := j.from.Snapshot(ctx, j.eventType)
			if err == nil {
				err = proj.Replay(ctx, j.consumer, j.eventType, records)
			}
			if err != nil {
				failed = append(failed, err)
				continue
			}
			log.Info("caught a copy up", slog.String("consumer", j.consumer), slog.String("event", j.eventType), slog.Int("records", len(records)))
		}
		return errors.Join(failed...)
	}
}
