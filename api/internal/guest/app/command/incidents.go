package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// cleanIncident fills the stay's villa and unit into the input and checks the scope.
func (d Deps) cleanIncident(ctx context.Context, p auth.Principal, in domain.IncidentInput) (domain.IncidentInput, domain.VillaRef, error) {
	villa, unitID, _, err := d.place(ctx, p, in.VillaID, in.UnitID, in.BookingID)
	in.VillaID, in.UnitID = villa.ID, unitID
	return in, villa, err
}

func (d Deps) incidentInScope(ctx context.Context, p auth.Principal, id string) (domain.Incident, domain.VillaRef, error) {
	i, err := d.Repo.Incident(ctx, id)
	if err != nil {
		return i, domain.VillaRef{}, err
	}
	v, err := d.villaInScope(ctx, p, i.VillaID)
	return i, v, err
}

func (d Deps) saveIncident(ctx context.Context, p auth.Principal, i *domain.Incident, v domain.VillaRef, line audit.Line) error {
	if err := d.Repo.UpdateIncident(ctx, i); err != nil {
		return err
	}
	if err := d.saved(ctx, guest.EventIncidentSaved, "incident", i.ID, i.Version, i, v); err != nil {
		return err
	}
	line.Entity, line.EntityID = "incident", i.Number
	return d.record(ctx, p, line)
}

// changeIncident loads an incident in scope that is not closed, applies fn and saves.
func (d Deps) changeIncident(ctx context.Context, p auth.Principal, id string, fn func(i *domain.Incident) (audit.Line, error)) (domain.Incident, error) {
	if err := d.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return domain.Incident{}, err
	}
	var i domain.Incident
	err := d.DB.InTx(ctx, func(ctx context.Context) error {
		var villa domain.VillaRef
		var err error
		if i, villa, err = d.incidentInScope(ctx, p, id); err != nil {
			return err
		}
		if err := domain.CheckIncidentOpen(i); err != nil {
			return err
		}
		line, err := fn(&i)
		if err != nil {
			return err
		}
		return d.saveIncident(ctx, p, &i, villa, line)
	})
	return i, err
}

// LogIncident is POST /incidents: guest/create and the villa in scope.
type LogIncident struct{ Deps }

// Handle logs the incident as open.
func (h LogIncident) Handle(ctx context.Context, p auth.Principal, in domain.IncidentInput) (domain.Incident, error) {
	if err := h.Authz.Require(ctx, p.Role, guestCreate...); err != nil {
		return domain.Incident{}, err
	}
	if err := domain.ValidateIncident(in, h.today()); err != nil {
		return domain.Incident{}, err
	}
	var i domain.Incident
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		clean, villa, err := h.cleanIncident(ctx, p, in)
		if err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "incident")
		if err != nil {
			return err
		}
		i = domain.Incident{ID: fmt.Sprintf("inc-%d", n), Number: fmt.Sprintf("IN-%03d", n), ReportedBy: p.Name, Status: "open",
			Timeline: []domain.IncidentEntry{{At: h.now(), By: p.Name, Kind: "logged", Note: ""}}}
		i.Apply(clean)
		if err := h.Repo.InsertIncident(ctx, &i); err != nil {
			return err
		}
		if err := h.saved(ctx, guest.EventIncidentSaved, "incident", i.ID, i.Version, i, villa); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "incident", EntityID: i.Number,
			Summary: fmt.Sprintf("Logged incident %s at %s: %s", i.Number, villa.Name, domain.IncidentKindLabel[i.Kind])})
	})
	return i, err
}

// UpdateIncident is PATCH /incidents/{id}: guest/edit.
type UpdateIncident struct{ Deps }

// Handle edits the incident's details.
func (h UpdateIncident) Handle(ctx context.Context, p auth.Principal, id string, in domain.IncidentInput) (domain.Incident, error) {
	if err := h.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return domain.Incident{}, err
	}
	if err := domain.ValidateIncident(in, h.today()); err != nil {
		return domain.Incident{}, err
	}
	return h.changeIncident(ctx, p, id, func(i *domain.Incident) (audit.Line, error) {
		clean, _, err := h.cleanIncident(ctx, p, in)
		if err != nil {
			return audit.Line{}, err
		}
		i.Apply(clean)
		return audit.Line{Action: audit.Update, Summary: "Edited " + i.Number}, nil
	})
}

// IncidentNote is the body of a follow-up or a close.
type IncidentNote struct {
	Note string `json:"note"`
}

// FollowUpIncident is POST /incidents/{id}/follow-ups: guest/edit.
type FollowUpIncident struct{ Deps }

// Handle appends the follow-up.
func (h FollowUpIncident) Handle(ctx context.Context, p auth.Principal, id string, in IncidentNote) (domain.Incident, error) {
	return h.changeIncident(ctx, p, id, func(i *domain.Incident) (audit.Line, error) {
		if len([]rune(strings.TrimSpace(in.Note))) < 3 {
			return audit.Line{}, errs.Invalid("note", "Write the follow-up.")
		}
		i.FollowUp(in.Note, p.Name, h.now())
		return audit.Line{Action: audit.Update, Summary: "Followed up " + i.Number}, nil
	})
}

// ChargeIncident is POST /incidents/{id}/charge: guest/edit; the damage goes on the stay's folio
// once, on DMG.
type ChargeIncident struct{ Deps }

// Handle charges the damage.
func (h ChargeIncident) Handle(ctx context.Context, p auth.Principal, id string, in domain.ChargeInput) (domain.Incident, error) {
	return h.changeIncident(ctx, p, id, func(i *domain.Incident) (audit.Line, error) {
		code := ""
		if i.Charge != nil {
			code = h.stayCode(ctx, i.Charge.BookingID)
		}
		if err := domain.ValidateCharge(*i, in, code); err != nil {
			return audit.Line{}, err
		}
		stay, err := h.Repo.Stay(ctx, *i.BookingID)
		if err != nil {
			return audit.Line{}, err
		}
		if err := inHouse(stay); err != nil {
			return audit.Line{}, err
		}
		reason := strings.TrimSpace(in.Reason)
		now := h.now()
		i.Charge = &domain.IncidentCharge{Amount: in.Amount, Reason: reason, BookingID: stay.ID, By: p.Name, At: now}
		i.Timeline = append(i.Timeline, domain.IncidentEntry{At: now, By: p.Name, Kind: "charge", Note: fmt.Sprintf("Charged %d to %s: %s", in.Amount, stay.Code, reason)})
		if err := h.requestPosting(ctx, p, "incident:"+i.ID, stay, guest.FolioPostingCharge, in.Amount, fmt.Sprintf("Damage, %s: %s", i.Number, reason)); err != nil {
			return audit.Line{}, err
		}
		return audit.Line{Action: audit.Create, Summary: fmt.Sprintf("Charged damage of %d on %s for %s", in.Amount, stay.Code, i.Number)}, nil
	})
}

// stayCode names a stay by its code, else its id.
func (d Deps) stayCode(ctx context.Context, id string) string {
	if s, err := d.Repo.Stay(ctx, id); err == nil {
		return s.Code
	}
	return id
}

// CloseIncident is POST /incidents/{id}/close: guest/edit and a sign-off by someone who may
// approve in the guest module.
type CloseIncident struct{ Deps }

// Handle signs the incident off.
func (h CloseIncident) Handle(ctx context.Context, p auth.Principal, id string, in IncidentNote) (domain.Incident, error) {
	return h.changeIncident(ctx, p, id, func(i *domain.Incident) (audit.Line, error) {
		if err := h.requireApprove(ctx, p, "sign off an incident"); err != nil {
			return audit.Line{}, err
		}
		note := strings.TrimSpace(in.Note)
		if len([]rune(note)) < 3 {
			return audit.Line{}, errs.Invalid("note", "Write the closing note.")
		}
		now, before := h.now(), i.Status
		i.Status, i.SignOff = "closed", &domain.SignOff{By: p.Name, At: now, Note: note}
		i.Timeline = append(i.Timeline, domain.IncidentEntry{At: now, By: p.Name, Kind: "closed", Note: note})
		return audit.Line{Action: audit.Status, Summary: "Signed off " + i.Number, Before: map[string]any{"status": before}, After: map[string]any{"status": "closed"}}, nil
	})
}
