// Package http maps the people context onto the contract paths the TypeScript HTTP adapter calls
// for the hr port and the people port.
package http

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/people/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/people/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/people/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
)

// Commands are the people write handlers.
type Commands struct {
	CreateEmployee     command.CreateEmployee
	UpdateEmployee     command.UpdateEmployee
	AssignShift        command.AssignShift
	RecordAttendance   command.RecordAttendance
	RequestLeave       command.RequestLeave
	DecideLeave        command.DecideLeave
	RequestOvertime    command.RequestOvertime
	DecideOvertime     command.DecideOvertime
	RequestLoan        command.RequestLoan
	DecideLoan         command.DecideLoan
	CreateAnnouncement command.CreateAnnouncement
	UpdateAnnouncement command.UpdateAnnouncement
	DeleteAnnouncement command.DeleteAnnouncement
	SaveKpi            command.SaveKpi
}

// Handler serves the people routes.
type Handler struct {
	Commands Commands
	Queries  query.Queries
	Log      *slog.Logger
}

func list[T any](log *slog.Logger, read func(r *http.Request) ([]T, error)) http.HandlerFunc {
	return httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		out, err := read(r)
		if err != nil {
			return err
		}
		if out == nil {
			out = []T{}
		}
		httpx.OK(w, out)
		return nil
	})
}

func write[In, Out any](log *slog.Logger, status int, run func(r *http.Request, p auth.Principal, in In) (Out, error)) http.HandlerFunc {
	return httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		var in In
		if err := httpx.Decode(r, &in); err != nil {
			return err
		}
		out, err := run(r, p, in)
		if err != nil {
			return err
		}
		httpx.JSON(w, status, out)
		return nil
	})
}

// note is the body of a decision.
type note struct {
	Note string `json:"note"`
}

// decide registers approve, reject and cancel for a request path.
func decide[Out any](r chi.Router, log *slog.Logger, path string, run func(r *http.Request, p auth.Principal, id, to, note string) (Out, error)) {
	for action, to := range map[string]string{"approve": domain.Approved, "reject": domain.Rejected, "cancel": domain.Cancelled} {
		r.Post(path+"/{id}/"+action, write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in note) (Out, error) {
			return run(r, p, chi.URLParam(r, "id"), to, in.Note)
		}))
	}
}

// Routes registers the routes under /api/v1.
func (h Handler) Routes(r chi.Router) {
	c, q, log := h.Commands, h.Queries, h.Log
	id := func(r *http.Request) string { return chi.URLParam(r, "id") }

	r.Get("/employees", list(log, func(r *http.Request) ([]domain.Employee, error) { return q.Employees(r.Context()) }))
	r.Post("/employees", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.Employee) (domain.Employee, error) {
		return c.CreateEmployee.Handle(r.Context(), p, in)
	}))
	r.Patch("/employees/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.Employee) (domain.Employee, error) {
		return c.UpdateEmployee.Handle(r.Context(), p, id(r), in)
	}))
	r.Get("/shifts", list(log, func(r *http.Request) ([]domain.Shift, error) { return q.Shifts(r.Context()) }))
	r.Get("/shift-assignments", list(log, func(r *http.Request) ([]domain.ShiftAssignment, error) { return q.Assignments(r.Context()) }))
	r.Put("/shift-assignments", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.AssignmentInput) (domain.ShiftAssignment, error) {
		return c.AssignShift.Handle(r.Context(), p, in)
	}))
	r.Get("/attendance", list(log, func(r *http.Request) ([]domain.Attendance, error) { return q.Attendance(r.Context()) }))
	r.Put("/attendance", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.AttendanceInput) (domain.Attendance, error) {
		return c.RecordAttendance.Handle(r.Context(), p, in)
	}))

	r.Get("/leave-requests", list(log, func(r *http.Request) ([]domain.LeaveRequest, error) { return q.Leaves(r.Context()) }))
	r.Post("/leave-requests", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.LeaveInput) (domain.LeaveRequest, error) {
		return c.RequestLeave.Handle(r.Context(), p, in)
	}))
	decide(r, log, "/leave-requests", func(r *http.Request, p auth.Principal, id, to, note string) (domain.LeaveRequest, error) {
		return c.DecideLeave.Handle(r.Context(), p, id, to, note)
	})
	r.Get("/overtime-requests", list(log, func(r *http.Request) ([]domain.OvertimeRequest, error) { return q.Overtime(r.Context()) }))
	r.Post("/overtime-requests", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.OvertimeInput) (domain.OvertimeRequest, error) {
		return c.RequestOvertime.Handle(r.Context(), p, in)
	}))
	decide(r, log, "/overtime-requests", func(r *http.Request, p auth.Principal, id, to, note string) (domain.OvertimeRequest, error) {
		return c.DecideOvertime.Handle(r.Context(), p, id, to, note)
	})
	r.Get("/loans", list(log, func(r *http.Request) ([]domain.Loan, error) { return q.Loans(r.Context()) }))
	r.Post("/loans", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.LoanInput) (domain.Loan, error) {
		return c.RequestLoan.Handle(r.Context(), p, in)
	}))
	decide(r, log, "/loans", func(r *http.Request, p auth.Principal, id, to, note string) (domain.Loan, error) {
		return c.DecideLoan.Handle(r.Context(), p, id, to, note)
	})

	r.Get("/announcements", list(log, func(r *http.Request) ([]domain.Announcement, error) { return q.Announcements(r.Context()) }))
	r.Post("/announcements", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.AnnouncementInput) (domain.Announcement, error) {
		return c.CreateAnnouncement.Handle(r.Context(), p, in)
	}))
	r.Patch("/announcements/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.AnnouncementInput) (domain.Announcement, error) {
		return c.UpdateAnnouncement.Handle(r.Context(), p, id(r), in)
	}))
	r.Delete("/announcements/{id}", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		if err := c.DeleteAnnouncement.Handle(r.Context(), p, id(r)); err != nil {
			return err
		}
		httpx.NoContent(w)
		return nil
	}))
	r.Get("/kpi-reviews", list(log, func(r *http.Request) ([]domain.KpiReview, error) { return q.Kpis(r.Context()) }))
	r.Post("/kpi-reviews", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.KpiInput) (domain.KpiReview, error) {
		return c.SaveKpi.Handle(r.Context(), p, "", in)
	}))
	r.Put("/kpi-reviews/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.KpiInput) (domain.KpiReview, error) {
		return c.SaveKpi.Handle(r.Context(), p, id(r), in)
	}))
}
