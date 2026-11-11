package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/people/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
)

// noticeVilla checks the villa a notice reaches and returns its location; "" for everyone.
func (d Deps) noticeVilla(ctx context.Context, p auth.Principal, villaID *string) (string, error) {
	if villaID == nil || *villaID == "" {
		return "", nil
	}
	v, err := d.villaInScope(ctx, p, *villaID)
	return v.LocationID, err
}

func (d Deps) saveNotice(ctx context.Context, a domain.Announcement, locationID string, version int64) error {
	row := Row{ID: a.ID, Data: a}
	if a.VillaID != nil {
		row.VillaIDs, row.LocationIDs = []string{*a.VillaID}, []string{locationID}
	}
	v, err := d.Repo.Save(ctx, Notices, row, version)
	if err != nil {
		return err
	}
	return d.emit(ctx, people.EventAnnouncementSaved, "announcement", a.ID, v, people.AnnouncementSaved{Announcement: a, LocationID: locationID})
}

// CreateAnnouncement publishes a notice; it needs hr/create and, for a villa notice, the villa in
// scope.
type CreateAnnouncement struct{ Deps }

// Handle publishes the notice.
func (h CreateAnnouncement) Handle(ctx context.Context, p auth.Principal, in domain.AnnouncementInput) (domain.Announcement, error) {
	if err := h.Authz.Require(ctx, p.Role, hrCreate...); err != nil {
		return domain.Announcement{}, err
	}
	if err := domain.ValidateAnnouncement(in); err != nil {
		return domain.Announcement{}, err
	}
	var a domain.Announcement
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		loc, err := h.noticeVilla(ctx, p, in.VillaID)
		if err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "announcement")
		if err != nil {
			return err
		}
		a = domain.Announcement{ID: fmt.Sprintf("ann-%d", n), PublishedOn: h.today(), By: p.Name}
		domain.ApplyAnnouncement(&a, in)
		if err := h.saveNotice(ctx, a, loc, 0); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "announcement", EntityID: a.ID, Summary: "Published “" + a.Title + "”"})
	})
	return a, err
}

// UpdateAnnouncement edits a notice; it needs hr/edit.
type UpdateAnnouncement struct{ Deps }

// Handle edits the notice.
func (h UpdateAnnouncement) Handle(ctx context.Context, p auth.Principal, id string, in domain.AnnouncementInput) (domain.Announcement, error) {
	if err := h.Authz.Require(ctx, p.Role, hrEdit...); err != nil {
		return domain.Announcement{}, err
	}
	if err := domain.ValidateAnnouncement(in); err != nil {
		return domain.Announcement{}, err
	}
	var a domain.Announcement
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		version, err := h.Repo.Load(ctx, Notices, id, &a)
		if err != nil {
			return err
		}
		if _, err := h.noticeVilla(ctx, p, a.VillaID); err != nil {
			return err
		}
		loc, err := h.noticeVilla(ctx, p, in.VillaID)
		if err != nil {
			return err
		}
		domain.ApplyAnnouncement(&a, in)
		return h.saveNotice(ctx, a, loc, version)
	})
	return a, err
}

// DeleteAnnouncement removes a notice; it needs hr/edit.
type DeleteAnnouncement struct{ Deps }

// Handle removes the notice.
func (h DeleteAnnouncement) Handle(ctx context.Context, p auth.Principal, id string) error {
	if err := h.Authz.Require(ctx, p.Role, hrEdit...); err != nil {
		return err
	}
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		var a domain.Announcement
		version, err := h.Repo.Load(ctx, Notices, id, &a)
		if err != nil {
			return err
		}
		if _, err := h.noticeVilla(ctx, p, a.VillaID); err != nil {
			return err
		}
		if err := h.Repo.Delete(ctx, Notices, id); err != nil {
			return err
		}
		if err := h.emit(ctx, people.EventAnnouncementRemoved, "announcement", id, version+1, people.AnnouncementRemoved{ID: id}); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Delete, Entity: "announcement", EntityID: id, Summary: "Removed “" + a.Title + "”"})
	})
}

// SaveKpi writes a scorecard; it needs hr/edit and the employee in scope. Without an id it
// replaces the employee's review of the same quarter, if any.
type SaveKpi struct{ Deps }

// Handle saves the review.
func (h SaveKpi) Handle(ctx context.Context, p auth.Principal, id string, in domain.KpiInput) (domain.KpiReview, error) {
	if err := h.Authz.Require(ctx, p.Role, hrEdit...); err != nil {
		return domain.KpiReview{}, err
	}
	if err := domain.ValidateKpi(in); err != nil {
		return domain.KpiReview{}, err
	}
	var k domain.KpiReview
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		e, err := h.employee(ctx, p, in.EmployeeID)
		if err != nil {
			return err
		}
		var existing domain.KpiReview
		var version int64
		if id != "" {
			version, err = h.Repo.Load(ctx, KpiReviews, id, &existing)
		} else {
			version, err = h.Repo.FindBy(ctx, KpiReviews, in.EmployeeID, in.Period, &existing)
		}
		if err != nil {
			return err
		}
		reviewID := existing.ID
		if version == 0 {
			n, err := h.Repo.Next(ctx, "kpi")
			if err != nil {
				return err
			}
			reviewID = fmt.Sprintf("kpi-%d", n)
		}
		k = domain.KpiReview{ID: reviewID, EmployeeID: in.EmployeeID, Period: in.Period, Items: append([]domain.KpiItem{}, in.Items...), Status: in.Status,
			Reviewer: p.Name, Note: strings.TrimSpace(in.Note), ReviewedOn: h.today()}
		v, err := h.Repo.Save(ctx, KpiReviews, Row{ID: k.ID, EmployeeID: k.EmployeeID, Key: k.Period, Data: k}, version)
		if err != nil {
			return err
		}
		if err := h.emit(ctx, people.EventKpiSaved, "kpi_review", k.ID, v, people.KpiSaved{Review: k}); err != nil {
			return err
		}
		action, verb := audit.Create, "Saved"
		if version > 0 {
			action = audit.Update
		}
		if in.Status == "published" {
			verb = "Published"
		}
		return h.record(ctx, p, audit.Line{Action: action, Entity: "kpi", EntityID: k.ID, Summary: fmt.Sprintf("%s the %s review for %s", verb, in.Period, e.Name)})
	})
	return k, err
}

// Repayment is what a closed payroll deducted from one employee for loans.
type Repayment struct {
	EmployeeID string
	Amount     int64
}

// BookRepayments reacts to a closed payroll: each deduction pays down the employee's active loans
// oldest first, and a loan repaid in full is settled. It runs in the projector's transaction.
type BookRepayments struct{ Deps }

// Handle books the repayments.
func (h BookRepayments) Handle(ctx context.Context, repayments []Repayment) error {
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		for _, r := range repayments {
			if r.Amount <= 0 {
				continue
			}
			loans, err := h.Repo.LockLoans(ctx, r.EmployeeID)
			if err != nil {
				return err
			}
			left := r.Amount
			for _, v := range loans {
				l := v.Value
				if l.Status != "active" {
					continue
				}
				take := min(left, l.Amount-l.Repaid)
				l.Repaid += take
				left -= take
				if l.Repaid >= l.Amount {
					l.Status = "settled"
				}
				if err := h.saveLoan(ctx, l, v.Version); err != nil {
					return err
				}
			}
		}
		return nil
	})
}
