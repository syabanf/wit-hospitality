// Package client holds maintenance's HTTP clients of other services, for split mode.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// PropertyBlocks places and frees unit holds through the property service's internal routes.
// Unlike the in-process client it cannot share the work order's transaction: a hold placed for a
// command that then fails stays until someone releases it on the unit blocks page.
type PropertyBlocks struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

var _ command.Blocks = PropertyBlocks{}

func (p PropertyBlocks) post(ctx context.Context, path string, body, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.BaseURL+"/internal/v1"+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", p.Token)
	client := p.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		var problem struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.NewDecoder(res.Body).Decode(&problem) == nil && problem.Error.Code != "" {
			return errs.New(problem.Error.Code, problem.Error.Message)
		}
		return fmt.Errorf("property %s: %s", path, res.Status)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// Hold calls POST /internal/v1/unit-blocks/holds.
func (p PropertyBlocks) Hold(ctx context.Context, unitID, from, to, note string) (string, error) {
	var body struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	err := p.post(ctx, "/unit-blocks/holds", map[string]string{"unitId": unitID, "from": from, "to": to, "note": note}, &body)
	return body.Data.ID, err
}

// Release calls POST /internal/v1/unit-blocks/{id}/release.
func (p PropertyBlocks) Release(ctx context.Context, blockID, today string) error {
	return p.post(ctx, "/unit-blocks/"+blockID+"/release", map[string]string{"today": today}, nil)
}
