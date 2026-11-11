// Package client is the HTTP implementation of channel.Prices for services that do not run the
// channel context (split mode). It calls channel's /internal/v1 routes with the shared internal
// token. The composition root builds it; other contexts see only the channel.Prices interface.
package client

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/channel"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// HTTP calls the channel service.
type HTTP struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

func (h HTTP) get(ctx context.Context, path string, query url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.BaseURL+"/internal/v1/channel/"+path+"?"+query.Encode(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-Internal-Token", h.Token)
	client := h.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	var body struct {
		Data  json.RawMessage `json:"data"`
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return fmt.Errorf("channel %s: %s: %w", path, res.Status, err)
	}
	if body.Error != nil {
		return errs.New(body.Error.Code, body.Error.Message)
	}
	return json.Unmarshal(body.Data, out)
}

// ActiveListing calls GET /internal/v1/channel/listings/active?unitId=.
func (h HTTP) ActiveListing(ctx context.Context, unitID string) (*channel.UnitListing, error) {
	var out *channel.UnitListing
	err := h.get(ctx, "listings/active", url.Values{"unitId": {unitID}}, &out)
	return out, err
}

// NightlyPrices calls GET /internal/v1/channel/prices?unitId=&from=&to=.
func (h HTTP) NightlyPrices(ctx context.Context, unitID, from, to string) ([]channel.NightPrice, bool, error) {
	var out struct {
		Listed bool                 `json:"listed"`
		Nights []channel.NightPrice `json:"nights"`
	}
	err := h.get(ctx, "prices", url.Values{"unitId": {unitID}, "from": {from}, "to": {to}}, &out)
	return out.Nights, out.Listed, err
}

var _ channel.Prices = HTTP{}
