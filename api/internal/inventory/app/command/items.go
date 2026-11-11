package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/inventory/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
)

func itemAudit(i domain.Item) map[string]any {
	return map[string]any{"reorderLevel": i.ReorderLevel, "par": i.Par, "active": i.Active}
}

// CreateItem adds a stock item every villa store may carry; it needs maintenance/create.
type CreateItem struct{ Deps }

// Handle adds the item.
func (h CreateItem) Handle(ctx context.Context, p auth.Principal, in domain.ItemInput) (domain.Item, error) {
	if err := h.Authz.Require(ctx, p.Role, needCreate); err != nil {
		return domain.Item{}, err
	}
	var i domain.Item
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		taken, err := h.Repo.ItemCodeTaken(ctx, in.Code, "")
		if err != nil {
			return err
		}
		if err := domain.ValidateItem(in, taken); err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "stockItem")
		if err != nil {
			return err
		}
		i = domain.Item{ID: fmt.Sprintf("stk-%d-%s", n, strings.ToLower(in.Code))}
		i.Apply(in)
		if err := h.Repo.InsertItem(ctx, &i); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "stock-item", EntityID: i.Code, Summary: fmt.Sprintf("Added stock item %s, %s", i.Code, i.Name)})
	})
	return i, err
}

// UpdateItem edits a stock item; it needs maintenance/edit. The average cost stays the replay's.
type UpdateItem struct{ Deps }

// Handle edits the item.
func (h UpdateItem) Handle(ctx context.Context, p auth.Principal, id string, in domain.ItemInput) (domain.Item, error) {
	if err := h.Authz.Require(ctx, p.Role, needEdit); err != nil {
		return domain.Item{}, err
	}
	var i domain.Item
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		taken, err := h.Repo.ItemCodeTaken(ctx, in.Code, id)
		if err != nil {
			return err
		}
		if err := domain.ValidateItem(in, taken); err != nil {
			return err
		}
		if i, err = h.Repo.Item(ctx, id); err != nil {
			return err
		}
		before := itemAudit(i)
		i.Apply(in)
		if err := h.Repo.UpdateItem(ctx, &i); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "stock-item", EntityID: i.Code, Summary: "Edited stock item " + i.Code, Before: before, After: itemAudit(i)})
	})
	return i, err
}
