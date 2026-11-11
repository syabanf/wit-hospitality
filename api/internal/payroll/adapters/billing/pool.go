// Package billing holds payroll's client of the billing context, which owns the folio and the
// Service charge payable it bills. Billing is not built yet, so the in-process client answers a
// pool of zero: payslips carry no service charge share until billing replaces it.
package billing

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/payroll/app/command"
)

// NoPool is the in-process ServicePool until billing exists.
type NoPool struct{}

var _ command.ServicePool = NoPool{}

// BilledServiceCharge answers zero for every month.
func (NoPool) BilledServiceCharge(context.Context, string) (int64, error) { return 0, nil }
