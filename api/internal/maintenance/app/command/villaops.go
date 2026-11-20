package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Meters, readings, the long-stay setting and upkeep templates
// (villa-operations-contract.md sections 3 and 4).

// Stay is maintenance's copy of a booking.
type Stay struct {
	ID       string
	Code     string
	Status   string
	UnitID   string
	CheckIn  string
	CheckOut string
	// Window is the stay's own service window, nil for the default.
	Window *domain.ServiceWindow
}

// VillaOps is the write model of meters and readings, with the stay copy and the villa's plans.
type VillaOps interface {
	LockVilla(ctx context.Context, villaID string) error
	Meters(ctx context.Context, villaID string) ([]domain.Meter, error)
	Meter(ctx context.Context, id string) (domain.Meter, error)
	SaveMeter(ctx context.Context, m domain.Meter) error
	Readings(ctx context.Context, meterID string) ([]domain.MeterReading, error)
	InsertReading(ctx context.Context, r domain.MeterReading) error
	LongStayNights(ctx context.Context, villaID string) (int, error)
	SaveLongStayNights(ctx context.Context, villaID string, nights int) error
	Stay(ctx context.Context, id string) (Stay, error)
	StayInHouse(ctx context.Context, unitIDs []string) (*Stay, error)
	UnitsOf(ctx context.Context, villaID string) ([]string, error)
	VillaPlans(ctx context.Context, villaID string) ([]domain.Plan, error)
}

var needPropertyEdit = rbac.Need{Module: "property", Action: "edit"}

// villaDefaultWindow is defaultServiceWindow('villa'): upkeep templates serve villas.
var villaDefaultWindow = domain.ServiceWindow{Mode: "window", From: "10:00", To: "12:00"}

func (d Deps) unitVilla(ctx context.Context) func(string) string {
	return func(id string) string {
		u, err := d.Repo.Unit(ctx, id)
		if err != nil {
			return ""
		}
		return u.VillaID
	}
}

// SaveMeter adds a meter (maintenance/create) or changes one (maintenance/edit).
type SaveMeter struct{ Deps }

// Handle saves the meter; id is empty for a new one.
func (h SaveMeter) Handle(ctx context.Context, p auth.Principal, id string, in domain.MeterInput) (domain.Meter, error) {
	need := needCreate
	if id != "" {
		need = needEdit
	}
	if err := h.Authz.Require(ctx, p.Role, need); err != nil {
		return domain.Meter{}, err
	}
	var out domain.Meter
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var current *domain.Meter
		villaID := in.VillaID
		if id != "" {
			m, err := h.Ops.Meter(ctx, id)
			if err != nil {
				return err
			}
			current, villaID = &m, m.VillaID
		}
		villa, err := h.villaInScope(ctx, p, villaID)
		if err != nil {
			return err
		}
		if err := h.Ops.LockVilla(ctx, villa.ID); err != nil {
			return err
		}
		meters, err := h.Ops.Meters(ctx, villa.ID)
		if err != nil {
			return err
		}
		if err := domain.ValidateMeter(in, villa.ID, villa.Name, meters, h.unitVilla(ctx), current); err != nil {
			return err
		}
		out = domain.Meter{VillaID: villa.ID, UnitID: emptyNil(in.UnitID), Kind: in.Kind, Number: strings.TrimSpace(in.Number), Unit: in.Unit, Tariff: int64(in.Tariff), Payer: in.Payer, Active: in.Active}
		action, summary := audit.Update, fmt.Sprintf("Changed meter %s of %s", out.Number, villa.Name)
		if current != nil {
			out.ID = current.ID
		} else {
			n, err := h.Repo.Next(ctx, "meter")
			if err != nil {
				return err
			}
			out.ID, action, summary = fmt.Sprintf("mtr-%d", n), audit.Create, fmt.Sprintf("Added meter %s to %s", out.Number, villa.Name)
		}
		if err := h.Ops.SaveMeter(ctx, out); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: action, Entity: "meter", EntityID: out.ID, Summary: summary})
	})
	return out, err
}

func emptyNil(s *string) *string {
	if s == nil || *s == "" {
		return nil
	}
	return s
}

// RecordReading records a meter reading; it needs maintenance/edit. A guest-paid check-out or an
// owner-paid monthly reading bills its usage through maintenance.utility.billed.v1, once.
type RecordReading struct{ Deps }

// Handle records the reading.
func (h RecordReading) Handle(ctx context.Context, p auth.Principal, in domain.ReadingInput) (domain.MeterReading, error) {
	if err := h.Authz.Require(ctx, p.Role, needEdit); err != nil {
		return domain.MeterReading{}, err
	}
	var out domain.MeterReading
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		m, err := h.Ops.Meter(ctx, in.MeterID)
		if err != nil {
			return err
		}
		villa, err := h.villaInScope(ctx, p, m.VillaID)
		if err != nil {
			return err
		}
		if err := h.Ops.LockVilla(ctx, villa.ID); err != nil {
			return err
		}
		readings, err := h.Ops.Readings(ctx, m.ID)
		if err != nil {
			return err
		}
		nights, err := h.Ops.LongStayNights(ctx, villa.ID)
		if err != nil {
			return err
		}
		var stay *domain.ReadingStay
		if in.Purpose != "monthly" && in.BookingID != nil && *in.BookingID != "" {
			s, err := h.Ops.Stay(ctx, *in.BookingID)
			if err != nil && !errs.HasCode(err, errs.CodeNotFound) {
				return err
			}
			if err == nil {
				stay = &domain.ReadingStay{ID: s.ID, Code: s.Code, UnitID: s.UnitID, Status: s.Status, CheckIn: s.CheckIn, CheckOut: s.CheckOut}
			}
		}
		serves := func(unitID string) bool {
			if m.UnitID != nil {
				return *m.UnitID == unitID
			}
			return h.unitVilla(ctx)(unitID) == m.VillaID
		}
		previous, consumption, err := domain.ValidateReading(in, domain.ReadingContext{Meter: m, Readings: readings, Today: h.today(), Stay: stay, LongStayNights: nights, Serves: serves, Nights: clock.DaysBetween})
		if err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "meterReading")
		if err != nil {
			return err
		}
		out = domain.MeterReading{ID: fmt.Sprintf("mrd-%d", n), MeterID: m.ID, VillaID: m.VillaID, UnitID: m.UnitID, On: in.On, Value: *in.Value, Photo: in.Photo,
			Purpose: in.Purpose, Replacement: in.Replacement, Previous: previous, Consumption: consumption, By: p.Name, ByID: p.UserID}
		if in.Purpose != "monthly" && stay != nil {
			id, code := stay.ID, stay.Code
			out.BookingID, out.BookingCode = &id, &code
		}
		summary := fmt.Sprintf("Read %s at %s %s on %s", m.Number, domain.Num(out.Value), m.Unit, out.On)
		if bill := domain.ReadingBill(m, out, readings); bill != nil {
			payer := bill.Payer
			out.Amount, out.BilledTo = bill.Amount, &payer
			summary += fmt.Sprintf(", billed %d to the %s", bill.Amount, payer)
			e := maintenance.UtilityBilled{ReadingID: out.ID, Payer: payer, BookingID: out.BookingID, BookingCode: out.BookingCode, MeterID: m.ID, MeterNumber: m.Number,
				Kind: m.Kind, Unit: m.Unit, Usage: bill.Usage, Tariff: m.Tariff, Amount: bill.Amount, VillaID: villa.ID, LocationID: villa.LocationID, Month: out.On[:7],
				On: out.On, Description: domain.UtilityDescription(m, bill.Usage), By: p.Name, ByID: p.UserID}
			if err := outbox.Append(ctx, h.DB.Q(ctx), h.Clock.Now(), outbox.Event{Type: maintenance.EventUtilityBilled, AggregateType: "meter_reading", AggregateID: out.ID, AggregateVersion: 1, Payload: e}); err != nil {
				return err
			}
		}
		if err := h.Ops.InsertReading(ctx, out); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "meter-reading", EntityID: out.ID, Summary: summary})
	})
	return out, err
}

// LongStayInput is the body of PUT /utility-settings/{villaId}.
type LongStayInput struct {
	LongStayNights float64 `json:"longStayNights"`
}

// SaveUtilitySettings sets a villa's long-stay length; it needs property/edit.
type SaveUtilitySettings struct{ Deps }

// Handle saves the setting.
func (h SaveUtilitySettings) Handle(ctx context.Context, p auth.Principal, villaID string, in LongStayInput) (domain.UtilitySettings, error) {
	if err := h.Authz.Require(ctx, p.Role, needPropertyEdit); err != nil {
		return domain.UtilitySettings{}, err
	}
	out := domain.UtilitySettings{VillaID: villaID, LongStayNights: int(in.LongStayNights)}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		villa, err := h.villaInScope(ctx, p, villaID)
		if err != nil {
			return err
		}
		if err := domain.ValidateLongStay(in.LongStayNights); err != nil {
			return err
		}
		before, err := h.Ops.LongStayNights(ctx, villa.ID)
		if err != nil {
			return err
		}
		if err := h.Ops.SaveLongStayNights(ctx, villa.ID, out.LongStayNights); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "utility-settings", EntityID: villa.ID,
			Summary: fmt.Sprintf("%s reads meters at check-in and check-out on stays of %d nights or more", villa.Name, out.LongStayNights),
			Before:  map[string]any{"longStayNights": before}, After: map[string]any{"longStayNights": out.LongStayNights}})
	})
	return out, err
}

// ApplyTemplate gives a villa the plans of an upkeep template; it needs maintenance/create.
type ApplyTemplate struct{ Deps }

// Handle adds the plans.
func (h ApplyTemplate) Handle(ctx context.Context, p auth.Principal, in domain.ApplyTemplateInput) ([]domain.Plan, error) {
	if err := h.Authz.Require(ctx, p.Role, needCreate); err != nil {
		return nil, err
	}
	var out []domain.Plan
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		villa, err := h.villaInScope(ctx, p, in.VillaID)
		if err != nil {
			return err
		}
		if err := h.Ops.LockVilla(ctx, villa.ID); err != nil {
			return err
		}
		plans, err := h.Ops.VillaPlans(ctx, villa.ID)
		if err != nil {
			return err
		}
		if err := domain.ValidateApplyTemplate(in, villa.Name, h.unitVilla(ctx), plans); err != nil {
			return err
		}
		for _, plan := range domain.TemplatePlans(in) {
			n, err := h.Repo.Next(ctx, "plan")
			if err != nil {
				return err
			}
			plan.ID = fmt.Sprintf("plan-%d", n)
			if err := h.Repo.InsertPlan(ctx, &plan); err != nil {
				return err
			}
			out = append(out, plan)
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "plan", EntityID: villa.ID,
			Summary: fmt.Sprintf("Applied the %s plans to %s: %d plans", domain.UpkeepTemplateLabel[in.Template], villa.Name, len(out))})
	})
	return out, err
}

// RecordUpkeep ticks an upkeep task's checklist, records pool chemistry and marks its notice
// sent; it needs maintenance/edit.
type RecordUpkeep struct{ Deps }

// Handle records the checklist.
func (h RecordUpkeep) Handle(ctx context.Context, p auth.Principal, id string, in domain.UpkeepInput) (domain.WorkOrder, error) {
	if err := h.Authz.Require(ctx, p.Role, needEdit); err != nil {
		return domain.WorkOrder{}, err
	}
	var w domain.WorkOrder
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if w, err = h.Repo.WorkOrder(ctx, id); err != nil {
			return err
		}
		villa, err := h.villaInScope(ctx, p, w.VillaID)
		if err != nil {
			return err
		}
		if err := w.ValidateUpkeep(in); err != nil {
			return err
		}
		w.RecordUpkeep(in, h.today())
		if err := h.Repo.UpdateWorkOrder(ctx, &w); err != nil {
			return err
		}
		if err := h.saved(ctx, w, villa.LocationID); err != nil {
			return err
		}
		summary := "Recorded the checklist on " + w.Number
		if r := w.Upkeep.Readings; r != nil {
			summary += fmt.Sprintf(": pH %s, chlorine %s", domain.Num(r.PH), domain.Num(r.Chlorine))
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "work-order", EntityID: w.Number, Summary: summary})
	})
	return w, err
}

// upkeepJob is what generation opens for an upkeep plan today; false skips it for a stay that
// asked not to be disturbed.
func (d Deps) upkeepJob(ctx context.Context, plan domain.Plan, villa Villa, job domain.NewInput) (domain.NewInput, bool, error) {
	if plan.Upkeep == nil || d.Ops == nil {
		return job, true, nil
	}
	units := []string{}
	if plan.UnitID != nil {
		units = append(units, *plan.UnitID)
	} else {
		var err error
		if units, err = d.Ops.UnitsOf(ctx, plan.VillaID); err != nil {
			return job, false, err
		}
	}
	s, err := d.Ops.StayInHouse(ctx, units)
	if err != nil {
		return job, false, err
	}
	var stay *domain.UpkeepStay
	if s != nil {
		window := villaDefaultWindow
		if s.Window != nil {
			window = *s.Window
		}
		stay = &domain.UpkeepStay{BookingID: s.ID, BookingCode: s.Code, Window: window}
	}
	upkeep, note := domain.UpkeepTask(plan, stay, villa.Name, d.today())
	if upkeep == nil {
		return job, false, nil
	}
	job.Upkeep = upkeep
	if note != "" {
		job.Description = strings.TrimSpace(job.Description + " " + note)
	}
	return job, true, nil
}
