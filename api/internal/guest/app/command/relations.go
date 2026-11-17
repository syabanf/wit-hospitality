package command

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// RelationsRepository is the write model of complaints, incidents and safe boxes.
type RelationsRepository interface {
	Complaint(ctx context.Context, id string) (domain.Complaint, error)
	InsertComplaint(ctx context.Context, c *domain.Complaint) error
	UpdateComplaint(ctx context.Context, c *domain.Complaint) error
	Incident(ctx context.Context, id string) (domain.Incident, error)
	InsertIncident(ctx context.Context, i *domain.Incident) error
	UpdateIncident(ctx context.Context, i *domain.Incident) error
	SafeBox(ctx context.Context, id string) (domain.SafeBox, error)
	SafeBoxesOf(ctx context.Context, villaID string) ([]domain.SafeBox, error)
	InsertSafeBox(ctx context.Context, b *domain.SafeBox) error
	UpdateSafeBox(ctx context.Context, b *domain.SafeBox) error
	BoxRental(ctx context.Context, id string) (domain.BoxRental, error)
	InsertBoxRental(ctx context.Context, b *domain.BoxRental) error
	UpdateBoxRental(ctx context.Context, b *domain.BoxRental) error
	// MoveRelations gives the dropped guest's complaints, box rentals and places in incidents to
	// the kept guest.
	MoveRelations(ctx context.Context, dropID, keepID string) error
}

// mayApprove reports whether the role may approve in the guest module.
func (d Deps) mayApprove(ctx context.Context, p auth.Principal) (bool, error) {
	matrix, err := d.Authz.Source.Permissions(ctx)
	if err != nil {
		return false, fmt.Errorf("load permissions: %w", err)
	}
	return rbac.Can(matrix, p.Role, "guest", "approve"), nil
}

// saved appends the record's saved event, with the villa and location it sits in.
func (d Deps) saved(ctx context.Context, eventType, aggregateType, id string, version int64, record any, v domain.VillaRef) error {
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return d.emit(ctx, eventType, aggregateType, id, version, guest.RecordSaved{Record: raw, VillaID: v.ID, LocationID: v.LocationID})
}

// inHouse refuses money on a stay that is not checked in.
func inHouse(s domain.Stay) error {
	if s.Status != "checked_in" {
		return errs.Newf("BOOKING_INVALID_STATE", "%s is not in house; post to the folio during the stay.", s.Code)
	}
	return nil
}

// requestPosting asks billing to post on the stay's folio; billing posts once per source.
func (d Deps) requestPosting(ctx context.Context, p auth.Principal, sourceID string, s domain.Stay, kind string, amount int64, description string) error {
	return d.emit(ctx, guest.EventFolioPostingRequested, "folio_posting", sourceID, 1, guest.FolioPostingRequested{
		SourceID: sourceID, BookingID: s.ID, VillaID: s.VillaID, Kind: kind, Amount: amount, Description: description, By: p.Name, ByID: p.UserID,
	})
}

// place cleans the villa, unit and stay of a record: the stay wins the villa and unit, the villa
// must be in scope and the unit in that villa. It answers the villa, the unit and the stay.
func (d Deps) place(ctx context.Context, p auth.Principal, villaID string, unitID, bookingID *string) (domain.VillaRef, *string, *domain.Stay, error) {
	if bookingID != nil && *bookingID != "" {
		s, err := d.Repo.Stay(ctx, *bookingID)
		if err != nil {
			return domain.VillaRef{}, nil, nil, err
		}
		villa, err := d.villaInScope(ctx, p, s.VillaID)
		return villa, &s.UnitID, &s, err
	}
	villa, err := d.villaInScope(ctx, p, villaID)
	if err != nil || unitID == nil || *unitID == "" {
		return villa, nil, nil, err
	}
	unit, err := d.Repo.Unit(ctx, *unitID)
	if err != nil {
		return villa, nil, nil, err
	}
	if unit.VillaID != villa.ID {
		return villa, nil, nil, errs.Newf(errs.CodeValidation, "%s is not in that villa.", unit.Code)
	}
	return villa, unitID, nil, nil
}
