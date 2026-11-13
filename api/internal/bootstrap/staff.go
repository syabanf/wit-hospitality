package bootstrap

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// lateStaff is people.Staff read through a closure: property, reservation and services are built
// before people, so they ask whichever client people's wiring leaves behind. Without one every
// answer is NOT_AVAILABLE.
type lateStaff struct {
	client func() people.Staff
}

func (s lateStaff) StaffMember(ctx context.Context, id string) (people.StaffMember, bool, error) {
	c := s.client()
	if c == nil {
		return people.StaffMember{}, false, errs.New("NOT_AVAILABLE", "People is not available in this API yet.")
	}
	return c.StaffMember(ctx, id)
}
