// Package stays holds inventory's stand-in for the reservation context.
package stays

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/inventory/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// None answers that no booking exists. The reservation context replaces it with a client (in
// process in the monolith, HTTP in split mode); until then a minibar check is refused NOT_FOUND.
type None struct{}

var _ command.Stays = None{}

// Stay finds no booking.
func (None) Stay(_ context.Context, bookingID string) (command.Stay, error) {
	return command.Stay{}, errs.NotFound("booking", bookingID)
}
