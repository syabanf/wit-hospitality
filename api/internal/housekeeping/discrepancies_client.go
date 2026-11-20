package housekeeping

import (
	"context"
	"net/http"
	"net/url"

	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
)

// Discrepancies answers billing's night audit: how many room checks on or before a date
// (YYYY-MM-DD) carry a discrepancy nobody resolved, across every villa. The composition root hands
// billing the in-process answer (housekeeping/module) in the monolith and DiscrepanciesHTTP in
// split mode.
type Discrepancies interface {
	OpenDiscrepancies(ctx context.Context, date string) (int, error)
}

// DiscrepanciesHTTP calls the housekeeping service's GET
// /internal/v1/housekeeping/open-discrepancies with INTERNAL_TOKEN.
type DiscrepanciesHTTP struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

// OpenDiscrepancyCount is the answer of GET /internal/v1/housekeeping/open-discrepancies.
type OpenDiscrepancyCount struct {
	Count int `json:"count"`
}

// OpenDiscrepancies calls GET /internal/v1/housekeeping/open-discrepancies?date=.
func (h DiscrepanciesHTTP) OpenDiscrepancies(ctx context.Context, date string) (int, error) {
	var out OpenDiscrepancyCount
	err := httpx.InternalGet(ctx, h.Client, h.BaseURL+"/internal/v1/housekeeping/open-discrepancies?"+url.Values{"date": {date}}.Encode(), h.Token, &out)
	return out.Count, err
}
