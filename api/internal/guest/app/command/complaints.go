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

// cleanComplaint fills the stay's villa, unit and guest into the input, checks the scope and the
// guest, and answers the villa and the guest's name.
func (d Deps) cleanComplaint(ctx context.Context, p auth.Principal, in domain.ComplaintInput) (domain.ComplaintInput, domain.VillaRef, string, error) {
	villa, unitID, stay, err := d.place(ctx, p, in.VillaID, in.UnitID, in.BookingID)
	if err != nil {
		return in, villa, "", err
	}
	in.VillaID, in.UnitID = villa.ID, unitID
	if stay != nil {
		if in.GuestID != nil && *in.GuestID != "" && *in.GuestID != stay.GuestID {
			return in, villa, "", errs.Newf(errs.CodeValidation, "%s is booked by another guest.", stay.Code)
		}
		in.GuestID = &stay.GuestID
	}
	g, err := d.Repo.Guest(ctx, *in.GuestID)
	if err != nil {
		return in, villa, "", err
	}
	return in, villa, g.Name, nil
}

// complaintInScope loads a complaint and its villa in the principal's scope.
func (d Deps) complaintInScope(ctx context.Context, p auth.Principal, id string) (domain.Complaint, domain.VillaRef, error) {
	c, err := d.Repo.Complaint(ctx, id)
	if err != nil {
		return c, domain.VillaRef{}, err
	}
	v, err := d.villaInScope(ctx, p, c.VillaID)
	return c, v, err
}

func (d Deps) saveComplaint(ctx context.Context, p auth.Principal, c *domain.Complaint, v domain.VillaRef, line audit.Line) error {
	if err := d.Repo.UpdateComplaint(ctx, c); err != nil {
		return err
	}
	if err := d.saved(ctx, guest.EventComplaintSaved, "complaint", c.ID, c.Version, c, v); err != nil {
		return err
	}
	line.Entity, line.EntityID = "complaint", c.Number
	return d.record(ctx, p, line)
}

// newComplaint inserts an open complaint and its saved event.
func (d Deps) newComplaint(ctx context.Context, p auth.Principal, in domain.ComplaintInput, source string) (domain.Complaint, domain.VillaRef, string, error) {
	clean, villa, guestName, err := d.cleanComplaint(ctx, p, in)
	if err != nil {
		return domain.Complaint{}, villa, "", err
	}
	n, err := d.Repo.Next(ctx, "complaint")
	if err != nil {
		return domain.Complaint{}, villa, "", err
	}
	c := domain.Complaint{ID: fmt.Sprintf("cpl-%d", n), Number: fmt.Sprintf("CP-%03d", n), Source: source, Status: "open", Links: []domain.Link{},
		Timeline: []domain.ComplaintEntry{{At: d.now(), By: p.Name, Kind: "logged", Note: ""}}}
	c.Apply(clean)
	if err := d.Repo.InsertComplaint(ctx, &c); err != nil {
		return c, villa, "", err
	}
	return c, villa, guestName, d.saved(ctx, guest.EventComplaintSaved, "complaint", c.ID, c.Version, c, villa)
}

// LogComplaint is POST /complaints: guest/create and the villa in scope.
type LogComplaint struct{ Deps }

// Handle logs the complaint as open.
func (h LogComplaint) Handle(ctx context.Context, p auth.Principal, in domain.ComplaintInput) (domain.Complaint, error) {
	if err := h.Authz.Require(ctx, p.Role, guestCreate...); err != nil {
		return domain.Complaint{}, err
	}
	if err := domain.ValidateComplaint(in, h.today()); err != nil {
		return domain.Complaint{}, err
	}
	var c domain.Complaint
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var villa domain.VillaRef
		var guestName string
		var err error
		if c, villa, guestName, err = h.newComplaint(ctx, p, in, "desk"); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "complaint", EntityID: c.Number,
			Summary: fmt.Sprintf("Logged complaint %s from %s at %s: %s", c.Number, guestName, villa.Name, domain.ComplaintCategoryLabel[c.Category])})
	})
	return c, err
}

// validateStayComplaint checks what the guest typed on the stay page.
func validateStayComplaint(in guest.StayComplaint) error {
	var f errs.Fields
	if _, ok := domain.ComplaintCategoryLabel[in.Category]; !ok {
		f.Add("category", "Pick what it is about.")
	}
	if len([]rune(strings.TrimSpace(in.Description))) < 5 {
		f.Add("description", "Tell us what went wrong.")
	}
	return f.Err()
}

// stayGuest is who files a complaint from the stay page: no scope, no module check, since
// reservation has checked the stay token.
var stayGuest = auth.Principal{UserID: "usr-guest", Name: "Guest", Role: "staff"}

// FileFromStay files the stay page's complaint as an open complaint by "Guest". Reservation writes
// the audit line with the guest action, so this writes none.
func (h LogComplaint) FileFromStay(ctx context.Context, in guest.StayComplaint) (guest.Filed, error) {
	if err := validateStayComplaint(in); err != nil {
		return guest.Filed{}, err
	}
	now := h.now()
	input := domain.ComplaintInput{BookingID: &in.BookingID, Category: in.Category, Severity: "medium", Description: in.Description,
		ReceivedBy: "Guest", ReceivedAt: now[:16], Owner: "Front desk"}
	var c domain.Complaint
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		c, _, _, err = h.newComplaint(ctx, stayGuest, input, "stay_page")
		return err
	})
	return guest.Filed{Number: c.Number}, err
}

// UpdateComplaint is PATCH /complaints/{id}: guest/edit; a closed complaint stays as it is.
type UpdateComplaint struct{ Deps }

// Handle edits the complaint's details.
func (h UpdateComplaint) Handle(ctx context.Context, p auth.Principal, id string, in domain.ComplaintInput) (domain.Complaint, error) {
	if err := h.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return domain.Complaint{}, err
	}
	if err := domain.ValidateComplaint(in, h.today()); err != nil {
		return domain.Complaint{}, err
	}
	var c domain.Complaint
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if c, _, err = h.complaintInScope(ctx, p, id); err != nil {
			return err
		}
		if err := domain.CheckComplaintOpen(c); err != nil {
			return err
		}
		clean, villa, _, err := h.cleanComplaint(ctx, p, in)
		if err != nil {
			return err
		}
		c.Apply(clean)
		return h.saveComplaint(ctx, p, &c, villa, audit.Line{Action: audit.Update, Summary: "Edited " + c.Number})
	})
	return c, err
}

// NoteBody is the body of POST /complaints/{id}/notes.
type NoteBody struct {
	Note string       `json:"note"`
	Ref  *domain.Link `json:"ref"`
}

// NoteComplaint is POST /complaints/{id}/notes: guest/edit.
type NoteComplaint struct{ Deps }

// Handle appends the note.
func (h NoteComplaint) Handle(ctx context.Context, p auth.Principal, id string, in NoteBody) (domain.Complaint, error) {
	if err := h.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return domain.Complaint{}, err
	}
	var c domain.Complaint
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var villa domain.VillaRef
		var err error
		if c, villa, err = h.complaintInScope(ctx, p, id); err != nil {
			return err
		}
		if err := domain.CheckComplaintOpen(c); err != nil {
			return err
		}
		if err := domain.ValidateNote(in.Note); err != nil {
			return err
		}
		c.AddNote(in.Note, in.Ref, p.Name, h.now())
		return h.saveComplaint(ctx, p, &c, villa, audit.Line{Action: audit.Update, Summary: "Noted on " + c.Number})
	})
	return c, err
}

// MoveBody is the body of POST /complaints/{id}/move.
type MoveBody struct {
	To   string `json:"to"`
	Note string `json:"note"`
}

// MoveComplaint is POST /complaints/{id}/move: guest/edit; in progress or closed along
// COMPLAINT_TRANSITIONS.
type MoveComplaint struct{ Deps }

// Handle moves the complaint.
func (h MoveComplaint) Handle(ctx context.Context, p auth.Principal, id string, in MoveBody) (domain.Complaint, error) {
	if err := h.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return domain.Complaint{}, err
	}
	var c domain.Complaint
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var villa domain.VillaRef
		var err error
		if c, villa, err = h.complaintInScope(ctx, p, id); err != nil {
			return err
		}
		if err := domain.ValidateComplaintMove(c, in.To); err != nil {
			return err
		}
		before := c.Status
		c.Move(in.To, in.Note, p.Name, h.now())
		return h.saveComplaint(ctx, p, &c, villa, audit.Line{Action: audit.Status,
			Summary: fmt.Sprintf("%s %s to %s", c.Number, strings.ToLower(domain.ComplaintStatusLabel[before]), strings.ToLower(domain.ComplaintStatusLabel[in.To])),
			Before:  map[string]any{"status": before}, After: map[string]any{"status": in.To}})
	})
	return c, err
}

func creditDescription(c domain.Complaint) string {
	return fmt.Sprintf("Compensation for %s: %s", c.Number, c.Compensation.Description)
}

// ResolveComplaint is POST /complaints/{id}/resolve: guest/edit. A folio credit up to
// COMPENSATION_LIMIT, or by someone who may approve, posts at once; a larger one waits.
type ResolveComplaint struct{ Deps }

// Handle resolves the complaint.
func (h ResolveComplaint) Handle(ctx context.Context, p auth.Principal, id string, in domain.ResolveInput) (domain.Complaint, error) {
	if err := h.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return domain.Complaint{}, err
	}
	var c domain.Complaint
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var villa domain.VillaRef
		var err error
		if c, villa, err = h.complaintInScope(ctx, p, id); err != nil {
			return err
		}
		if err := domain.ValidateResolve(c, in); err != nil {
			return err
		}
		before := c.Status
		post := false
		var stay domain.Stay
		if k := in.Compensation; k != nil && k.Kind == "folio_credit" {
			if stay, err = h.Repo.Stay(ctx, *c.BookingID); err != nil {
				return err
			}
			if err := inHouse(stay); err != nil {
				return err
			}
			approver, err := h.mayApprove(ctx, p)
			if err != nil {
				return err
			}
			post = k.Amount <= domain.CompensationLimit || approver
		}
		if c.Resolve(in, post, p.Name, h.now()) {
			if err := h.requestPosting(ctx, p, "complaint:"+c.ID, stay, guest.FolioPostingCredit, c.Compensation.Amount, creditDescription(c)); err != nil {
				return err
			}
		}
		return h.saveComplaint(ctx, p, &c, villa, audit.Line{Action: audit.Status, Summary: fmt.Sprintf("Resolved %s: %s", c.Number, c.Resolution.Action),
			Before: map[string]any{"status": before}, After: map[string]any{"status": "resolved"}})
	})
	return c, err
}

// DecideCompensation is POST /complaints/{id}/compensation: guest/edit and approve in the guest
// module; approving posts the waiting credit.
type DecideCompensation struct{ Deps }

// Handle approves or refuses the credit.
func (h DecideCompensation) Handle(ctx context.Context, p auth.Principal, id string, in domain.CompensationDecision) (domain.Complaint, error) {
	if err := h.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return domain.Complaint{}, err
	}
	var c domain.Complaint
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var villa domain.VillaRef
		var err error
		if c, villa, err = h.complaintInScope(ctx, p, id); err != nil {
			return err
		}
		if err := domain.CheckPending(c); err != nil {
			return err
		}
		if err := h.requireApprove(ctx, p, "approve compensation"); err != nil {
			return err
		}
		if err := domain.ValidateDecision(c, in); err != nil {
			return err
		}
		verb := "Refused"
		if in.Approve {
			verb = "Approved"
			stay, err := h.Repo.Stay(ctx, *c.BookingID)
			if err != nil {
				return err
			}
			if err := inHouse(stay); err != nil {
				return err
			}
			if err := h.requestPosting(ctx, p, "complaint:"+c.ID, stay, guest.FolioPostingCredit, c.Compensation.Amount, creditDescription(c)); err != nil {
				return err
			}
		}
		c.Decide(in, p.Name, h.now())
		return h.saveComplaint(ctx, p, &c, villa, audit.Line{Action: audit.Approve, Summary: fmt.Sprintf("%s the credit of %d on %s", verb, c.Compensation.Amount, c.Number)})
	})
	return c, err
}
