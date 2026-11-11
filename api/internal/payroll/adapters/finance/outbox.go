// Package finance holds payroll's client of the finance context. Finance is not built yet, so the
// in-process client records the salary payment request as payroll.period.closed.v1 in payroll's
// outbox, in the closing transaction, for finance to consume when it exists.
package finance

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/payroll"
	"github.com/syabanf/wit-hospitality/api/internal/payroll/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
)

// Outbox is the in-process PayrollPosting.
type Outbox struct {
	DB    *db.DB
	Clock clock.Clock
}

var _ command.PayrollPosting = Outbox{}

// PostSalaryPayment appends the request and returns no transaction id: no cash-out exists until
// finance posts one.
func (o Outbox) PostSalaryPayment(ctx context.Context, closed payroll.PeriodClosed) (*string, error) {
	err := outbox.Append(ctx, o.DB.Q(ctx), o.Clock.Now(), outbox.Event{
		Type: payroll.EventPeriodClosed, AggregateType: "payroll_period", AggregateID: closed.PeriodID, Payload: closed,
	})
	return nil, err
}
