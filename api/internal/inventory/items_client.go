package inventory

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// StockItem is what other contexts read of a stock item: housekeeping names linen in LINEN_SHORT
// and keeps linen pars to linen.
type StockItem struct {
	ID   string `json:"id"`
	Code string `json:"code"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}

// Items lists the stock items, shared by every villa. It needs no session, since the caller
// already checked its own. The composition root hands a consumer the in-process implementation
// (inventory/module) in the monolith and HTTPClient in split mode.
type Items interface {
	Items(ctx context.Context) ([]StockItem, error)
}

// HTTPClient calls the inventory service's /internal/v1 routes with the shared INTERNAL_TOKEN.
type HTTPClient struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

// Items calls GET /internal/v1/stock/items.
func (h HTTPClient) Items(ctx context.Context) ([]StockItem, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.BaseURL+"/internal/v1/stock/items", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Internal-Token", h.Token)
	client := h.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var envelope struct {
		Data  []StockItem `json:"data"`
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&envelope); err != nil {
		return nil, fmt.Errorf("inventory GET /internal/v1/stock/items: %s: %w", res.Status, err)
	}
	if envelope.Error != nil {
		return nil, errs.New(envelope.Error.Code, envelope.Error.Message)
	}
	if res.StatusCode >= 300 {
		return nil, fmt.Errorf("inventory GET /internal/v1/stock/items: %s", res.Status)
	}
	return envelope.Data, nil
}
