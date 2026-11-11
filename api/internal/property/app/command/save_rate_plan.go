package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
)

// SaveRatePlan creates or replaces a room type's rate plan; it needs property/edit and the villa
// in scope. Stays already booked keep their price: they stored their nights when sold.
type SaveRatePlan struct{ Deps }

// Handle saves the plan.
func (h SaveRatePlan) Handle(ctx context.Context, p auth.Principal, groupID string, in domain.RatePlanInput) (domain.RatePlan, error) {
	if err := h.Authz.Require(ctx, p.Role, propertyEdit...); err != nil {
		return domain.RatePlan{}, err
	}
	if err := domain.ValidateRatePlan(in); err != nil {
		return domain.RatePlan{}, err
	}
	var plan domain.RatePlan
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		group, err := h.Repo.Group(ctx, groupID)
		if err != nil {
			return err
		}
		villa, err := h.Repo.Villa(ctx, group.VillaID)
		if err != nil {
			return err
		}
		if err := inScope(p, villa); err != nil {
			return err
		}
		before, err := h.Repo.RatePlan(ctx, groupID)
		if err != nil {
			return err
		}
		plan = in.Plan(groupID)
		if before != nil {
			plan.Version = before.Version
		}
		if err := h.Repo.SaveRatePlan(ctx, &plan); err != nil {
			return err
		}
		if err := h.planEvent(ctx, plan, villa); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{
			Action: audit.Update, Entity: "rate_plan", EntityID: groupID,
			Summary: fmt.Sprintf("Priced %s: weekday %d, weekend %d, %d seasons", group.Name, plan.WeekdayRate, plan.WeekendRate, len(plan.Seasons)),
			Before:  planSummary(before), After: planSummary(&plan),
		})
	})
	return plan, err
}
