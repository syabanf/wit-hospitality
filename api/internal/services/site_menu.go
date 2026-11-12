package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// SiteMenuHTTP reads the room service menu the public site prints from the services service's
// GET /internal/v1/site-menu with INTERNAL_TOKEN, for a channel service in split mode. In the
// monolith channel reads services' module in process instead.
type SiteMenuHTTP struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

// Menu lists the active menu items as the site prints them: no partner, cost, photo or hours.
func (h SiteMenuHTTP) Menu(ctx context.Context) ([]json.RawMessage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.BaseURL+"/internal/v1/site-menu", nil)
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
		Data  []json.RawMessage `json:"data"`
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&envelope); err != nil {
		return nil, fmt.Errorf("services GET /internal/v1/site-menu: %s: %w", res.Status, err)
	}
	if envelope.Error != nil {
		return nil, errs.New(envelope.Error.Code, envelope.Error.Message)
	}
	if res.StatusCode >= 300 {
		return nil, fmt.Errorf("services GET /internal/v1/site-menu: %s", res.Status)
	}
	return envelope.Data, nil
}
