package clients

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// DemoGateway stands in for the card gateway, as the demo settle of payment links does: a card
// ending 0000 is declined, a hold taken without an approval code gets the gateway's, and capture
// and release always go through.
type DemoGateway struct{}

// Authorize holds the card.
func (DemoGateway) Authorize(_ context.Context, hold domain.PreAuth, n int64) (string, error) {
	if hold.Last4 == "0000" {
		return "", errs.Newf("PREAUTH_DECLINED", "The gateway declined the hold on %s ending %s.", domain.BrandLabel[hold.Brand], hold.Last4)
	}
	if hold.ApprovalCode != "" {
		return hold.ApprovalCode, nil
	}
	return domain.GatewayApprovalCode(n), nil
}

// Capture takes the amount.
func (DemoGateway) Capture(context.Context, domain.PreAuth, int64) error { return nil }

// Release lets the hold go.
func (DemoGateway) Release(context.Context, domain.PreAuth) error { return nil }

// Discrepancies reads housekeeping's open room discrepancies through its published client; Client
// returns nil while no housekeeping runs here or answers, and then none are open.
type Discrepancies struct {
	Client func() housekeeping.Discrepancies
}

// OpenDiscrepancies counts the open discrepancies on or before date.
func (d Discrepancies) OpenDiscrepancies(ctx context.Context, date string) (int, error) {
	var c housekeeping.Discrepancies
	if d.Client != nil {
		c = d.Client()
	}
	if c == nil {
		return 0, nil
	}
	return c.OpenDiscrepancies(ctx, date)
}
