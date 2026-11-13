package command

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/property"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// WizardBy names who added a room type's starting minimum stay.
const WizardBy = "New property wizard"

// WizardMinStays gives the room types the New property wizard created their starting minimum
// stay (rooms 1 night and villas 2 unless the wizard set another) as a yearly min_stay restriction
// over the whole year, which staff edit like any other. One night needs no restriction. The
// restriction id comes from the room type, so a redelivered event adds nothing.
type WizardMinStays struct{ Deps }

// Handle adds the restrictions.
func (h WizardMinStays) Handle(ctx context.Context, e property.PropertyCreated) error {
	villa := domain.Villa{ID: e.VillaID, LocationID: e.LocationID}
	for _, m := range e.MinStays {
		if m.Nights <= 1 {
			continue
		}
		id := "rst-min-" + m.GroupID
		if _, err := h.Repo.Restriction(ctx, id); !errs.HasCode(err, errs.CodeNotFound) {
			if err != nil {
				return err
			}
			continue
		}
		nights := float64(m.Nights)
		r := domain.NewRestriction(id, domain.RestrictionInput{GroupID: m.GroupID, Rule: "min_stay", Nights: &nights, Yearly: true, From: "01-01", To: "12-31",
			Note: "Starting minimum stay"}, WizardBy, h.today())
		if err := h.Repo.InsertRestriction(ctx, &r); err != nil {
			return err
		}
		if err := h.emit(ctx, reservation.EventRestrictionSaved, "restriction", r.ID, r.Version, recordOf(r.ID, []domain.Villa{villa}, r)); err != nil {
			return err
		}
	}
	return nil
}
