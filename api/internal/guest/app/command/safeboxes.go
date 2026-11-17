package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
)

func (d Deps) saveBox(ctx context.Context, b *domain.SafeBox, v domain.VillaRef, insert bool) error {
	save := d.Repo.UpdateSafeBox
	if insert {
		save = d.Repo.InsertSafeBox
	}
	if err := save(ctx, b); err != nil {
		return err
	}
	return d.saved(ctx, guest.EventSafeBoxSaved, "safe_box", b.ID, b.Version, b, v)
}

// checkBox validates a box against the other boxes of its villa.
func (d Deps) checkBox(ctx context.Context, in domain.SafeBoxInput, v domain.VillaRef, id string) error {
	boxes, err := d.Repo.SafeBoxesOf(ctx, v.ID)
	if err != nil {
		return err
	}
	others := boxes[:0]
	for _, b := range boxes {
		if b.ID != id {
			others = append(others, b)
		}
	}
	return domain.ValidateSafeBox(in, others, v.Name)
}

// AddSafeBox is POST /safe-boxes: guest/edit and the villa in scope.
type AddSafeBox struct{ Deps }

// Handle adds the box.
func (h AddSafeBox) Handle(ctx context.Context, p auth.Principal, in domain.SafeBoxInput) (domain.SafeBox, error) {
	if err := h.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return domain.SafeBox{}, err
	}
	var b domain.SafeBox
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		villa, err := h.villaInScope(ctx, p, in.VillaID)
		if err != nil {
			return err
		}
		if err := h.checkBox(ctx, in, villa, ""); err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "safeBox")
		if err != nil {
			return err
		}
		b = domain.SafeBox{ID: fmt.Sprintf("box-%d", n), VillaID: villa.ID, Status: "free"}
		if err := b.Apply(in); err != nil {
			return err
		}
		if err := h.saveBox(ctx, &b, villa, true); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "safe-box", EntityID: b.ID, Summary: fmt.Sprintf("Added safe box %s at %s", b.Number, villa.Name)})
	})
	return b, err
}

// UpdateSafeBox is PATCH /safe-boxes/{id}: guest/edit; the villa stays.
type UpdateSafeBox struct{ Deps }

// Handle changes the box.
func (h UpdateSafeBox) Handle(ctx context.Context, p auth.Principal, id string, in domain.SafeBoxInput) (domain.SafeBox, error) {
	if err := h.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return domain.SafeBox{}, err
	}
	var b domain.SafeBox
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if b, err = h.Repo.SafeBox(ctx, id); err != nil {
			return err
		}
		villa, err := h.villaInScope(ctx, p, b.VillaID)
		if err != nil {
			return err
		}
		if err := h.checkBox(ctx, in, villa, b.ID); err != nil {
			return err
		}
		if err := b.Apply(in); err != nil {
			return err
		}
		if err := h.saveBox(ctx, &b, villa, false); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "safe-box", EntityID: b.ID, Summary: fmt.Sprintf("Changed safe box %s at %s", b.Number, villa.Name)})
	})
	return b, err
}

// rentalInScope loads a rental, its box, its stay and its villa in the principal's scope.
func (d Deps) rentalInScope(ctx context.Context, p auth.Principal, id string) (domain.BoxRental, domain.SafeBox, domain.Stay, domain.VillaRef, error) {
	r, err := d.Repo.BoxRental(ctx, id)
	if err != nil {
		return r, domain.SafeBox{}, domain.Stay{}, domain.VillaRef{}, err
	}
	v, err := d.villaInScope(ctx, p, r.VillaID)
	if err != nil {
		return r, domain.SafeBox{}, domain.Stay{}, v, err
	}
	box, err := d.Repo.SafeBox(ctx, r.BoxID)
	if err != nil {
		return r, box, domain.Stay{}, v, err
	}
	stay, err := d.Repo.Stay(ctx, r.BookingID)
	return r, box, stay, v, err
}

func (d Deps) saveRental(ctx context.Context, p auth.Principal, r *domain.BoxRental, v domain.VillaRef, insert bool, summary string) error {
	save := d.Repo.UpdateBoxRental
	if insert {
		save = d.Repo.InsertBoxRental
	}
	if err := save(ctx, r); err != nil {
		return err
	}
	if err := d.saved(ctx, guest.EventBoxRentalSaved, "box_rental", r.ID, r.Version, r, v); err != nil {
		return err
	}
	return d.record(ctx, p, audit.Line{Action: audit.Update, Entity: "safe-box-rental", EntityID: r.Number, Summary: summary})
}

// OpenBox is POST /safe-box-rentals: guest/edit; the box goes in use for the stay.
type OpenBox struct{ Deps }

// Handle opens the box.
func (h OpenBox) Handle(ctx context.Context, p auth.Principal, in domain.OpenBoxInput) (domain.BoxRental, error) {
	if err := h.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return domain.BoxRental{}, err
	}
	var r domain.BoxRental
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		box, err := h.Repo.SafeBox(ctx, in.BoxID)
		if err != nil {
			return err
		}
		villa, err := h.villaInScope(ctx, p, box.VillaID)
		if err != nil {
			return err
		}
		stay, err := h.Repo.Stay(ctx, in.BookingID)
		if err != nil {
			return err
		}
		if err := domain.ValidateOpenBox(box, stay, in); err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "boxRental")
		if err != nil {
			return err
		}
		now := h.now()
		r = domain.BoxRental{ID: fmt.Sprintf("bxr-%d", n), Number: fmt.Sprintf("SB-%03d", n), BoxID: box.ID, VillaID: box.VillaID, BookingID: stay.ID, GuestID: stay.GuestID,
			Items: strings.TrimSpace(in.Items), KeyNumber: strings.TrimSpace(in.KeyNumber), Status: "open", OpenedAt: now, OpenedBy: p.Name,
			Log: []domain.BoxEntry{{Kind: "open", At: now, By: p.Name, Signature: in.Signature, SignatureData: in.Data(), Note: ""}}}
		box.Status = "in_use"
		if err := h.saveBox(ctx, &box, villa, false); err != nil {
			return err
		}
		return h.saveRental(ctx, p, &r, villa, true, fmt.Sprintf("Opened box %s for %s (%s)", box.Number, stay.Code, r.Number))
	})
	return r, err
}

// AccessBox is POST /safe-box-rentals/{id}/access: guest/edit; logs an add or a take.
type AccessBox struct{ Deps }

// Handle logs the access.
func (h AccessBox) Handle(ctx context.Context, p auth.Principal, id string, in domain.BoxAccessInput) (domain.BoxRental, error) {
	if err := h.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return domain.BoxRental{}, err
	}
	var r domain.BoxRental
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var box domain.SafeBox
		var stay domain.Stay
		var villa domain.VillaRef
		var err error
		if r, box, stay, villa, err = h.rentalInScope(ctx, p, id); err != nil {
			return err
		}
		if err := domain.ValidateBoxAccess(r, in); err != nil {
			return err
		}
		r.Access(in, p.Name, h.now())
		what := "added items"
		if in.Kind == "take" {
			what = "took items out"
		}
		return h.saveRental(ctx, p, &r, villa, false, fmt.Sprintf("Box %s for %s: %s", box.Number, stay.Code, what))
	})
	return r, err
}

// CloseBox is POST /safe-box-rentals/{id}/close: guest/edit; the key comes back or its fee goes
// on the folio, and the box is free again.
type CloseBox struct{ Deps }

// Handle closes the rental.
func (h CloseBox) Handle(ctx context.Context, p auth.Principal, id string, in domain.CloseBoxInput) (domain.BoxRental, error) {
	if err := h.Authz.Require(ctx, p.Role, guestEdit...); err != nil {
		return domain.BoxRental{}, err
	}
	var r domain.BoxRental
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var box domain.SafeBox
		var stay domain.Stay
		var villa domain.VillaRef
		var err error
		if r, box, stay, villa, err = h.rentalInScope(ctx, p, id); err != nil {
			return err
		}
		if err := domain.ValidateCloseBox(r, in); err != nil {
			return err
		}
		if in.KeyFee > 0 {
			if err := inHouse(stay); err != nil {
				return err
			}
			if err := h.requestPosting(ctx, p, "box-rental:"+r.ID, stay, guest.FolioPostingCharge, in.KeyFee, fmt.Sprintf("Lost safe box key, box %s (%s)", box.Number, r.Number)); err != nil {
				return err
			}
		}
		r.Close(in, p.Name, h.now())
		if box.Status == "in_use" {
			box.Status = "free"
			if err := h.saveBox(ctx, &box, villa, false); err != nil {
				return err
			}
		}
		key := "key returned"
		if !in.KeyReturned {
			key = "key lost"
		}
		return h.saveRental(ctx, p, &r, villa, false, fmt.Sprintf("Closed box %s for %s: %s", box.Number, stay.Code, key))
	})
	return r, err
}
