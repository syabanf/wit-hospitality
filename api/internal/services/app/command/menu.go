package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/services"
	"github.com/syabanf/wit-hospitality/api/internal/services/domain"
)

// menuEditor is the mock's assertMenuEditor: services/catalog, with its wording.
func (d Deps) menuEditor(ctx context.Context, p auth.Principal) error {
	ok, err := d.can(ctx, p, "services", "catalog")
	if err != nil || ok {
		return err
	}
	return errs.Forbidden(fmt.Sprintf("%s cannot edit the room service menu.", rbac.RoleLabel[p.Role]))
}

func (d Deps) villa(ctx context.Context, id string) (domain.Villa, error) {
	v, ok, err := d.Catalog.Villa(ctx, id)
	if err != nil {
		return v, err
	}
	if !ok {
		return v, errs.NotFound("villa", id)
	}
	return v, nil
}

func (d Deps) checkPartner(ctx context.Context, id *string) error {
	if id == nil || *id == "" {
		return nil
	}
	_, err := d.Repo.Partner(ctx, *id)
	return err
}

func (d Deps) menuEvent(ctx context.Context, m domain.MenuItem, v domain.Villa) error {
	return d.emit(ctx, services.EventMenuItemSaved, "menu_item", m.ID, m.Version, services.MenuItemSaved{Item: mustJSON(m), LocationID: v.LocationID})
}

// SaveMenuItem is POST /menu-items and PATCH /menu-items/{id}.
type SaveMenuItem struct{ Deps }

// Handle creates the item when id is empty, else edits it.
func (h SaveMenuItem) Handle(ctx context.Context, p auth.Principal, id string, in domain.MenuItemInput) (domain.MenuItem, error) {
	var out domain.MenuItem
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.menuEditor(ctx, p); err != nil {
			return err
		}
		if err := domain.ValidateMenuItem(in); err != nil {
			return err
		}
		if id == "" {
			v, err := h.villa(ctx, in.VillaID)
			if err != nil {
				return err
			}
			if err := inScope(p, v); err != nil {
				return err
			}
			if err := h.checkPartner(ctx, in.PartnerID); err != nil {
				return err
			}
			out = domain.MenuItem{ID: ids.New("mi", in.Name)}
			out.Apply(in)
			if err := h.Repo.InsertMenuItem(ctx, &out); err != nil {
				return err
			}
			if err := h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "menu-item", EntityID: out.ID,
				Summary: fmt.Sprintf("Added %s to the %s menu", out.Name, v.Name), After: map[string]any{"price": out.Price}}); err != nil {
				return err
			}
			return h.menuEvent(ctx, out, v)
		}
		item, err := h.Repo.MenuItem(ctx, id)
		if err != nil {
			return err
		}
		old, err := h.villa(ctx, item.VillaID)
		if err != nil {
			return err
		}
		if err := inScope(p, old); err != nil {
			return err
		}
		v, err := h.villa(ctx, in.VillaID)
		if err != nil {
			return err
		}
		if err := inScope(p, v); err != nil {
			return err
		}
		if err := h.checkPartner(ctx, in.PartnerID); err != nil {
			return err
		}
		before := map[string]any{"price": item.Price, "active": item.Active, "costPrice": item.CostPrice}
		item.Apply(in)
		if err := h.Repo.UpdateMenuItem(ctx, &item); err != nil {
			return err
		}
		out = item
		if err := h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "menu-item", EntityID: id, Summary: fmt.Sprintf("Edited %s on the menu", item.Name),
			Before: before, After: map[string]any{"price": item.Price, "active": item.Active, "costPrice": item.CostPrice}}); err != nil {
			return err
		}
		return h.menuEvent(ctx, item, v)
	})
	return out, err
}

// SavePartner is POST /service-partners and PATCH /service-partners/{id}.
type SavePartner struct{ Deps }

// Handle creates the partner when id is empty, else edits it.
func (h SavePartner) Handle(ctx context.Context, p auth.Principal, id string, in domain.PartnerInput) (domain.ServicePartner, error) {
	var out domain.ServicePartner
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.menuEditor(ctx, p); err != nil {
			return err
		}
		if err := domain.ValidatePartner(in); err != nil {
			return err
		}
		line := audit.Line{Action: audit.Update, Entity: "service-partner", EntityID: id}
		if id == "" {
			out = domain.ServicePartner{ID: ids.New("ptn", in.Name)}
			line = audit.Line{Action: audit.Create, Entity: "service-partner", EntityID: out.ID}
		} else {
			var err error
			if out, err = h.Repo.Partner(ctx, id); err != nil {
				return err
			}
		}
		out.Name, out.Kind, out.Contact, out.Phone, out.Active = strings.TrimSpace(in.Name), in.Kind, in.Contact, in.Phone, in.Active
		var err error
		if id == "" {
			err = h.Repo.InsertPartner(ctx, &out)
			line.Summary = "Added partner " + out.Name
		} else {
			err = h.Repo.UpdatePartner(ctx, &out)
			line.Summary = "Edited partner " + out.Name
		}
		if err != nil {
			return err
		}
		if err := h.record(ctx, p, line); err != nil {
			return err
		}
		return h.emit(ctx, services.EventPartnerSaved, "partner", out.ID, out.Version, services.PartnerSaved{Partner: mustJSON(out)})
	})
	return out, err
}
