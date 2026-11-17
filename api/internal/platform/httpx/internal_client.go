package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// InternalPost sends body to another service's /internal/v1 route with INTERNAL_TOKEN and reads
// the envelope's data into out (nil skips it). A refusal comes back as *errs.Error with the other
// service's code, message and fields.
func InternalPost(ctx context.Context, client *http.Client, url, token string, body, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	return internalDo(client, req, token, out)
}

// InternalGet reads another service's /internal/v1 route with INTERNAL_TOKEN into out, as
// InternalPost does.
func InternalGet(ctx context.Context, client *http.Client, url, token string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	return internalDo(client, req, token, out)
}

func internalDo(client *http.Client, req *http.Request, token string, out any) error {
	url := req.Method + " " + req.URL.String()
	req.Header.Set("X-Internal-Token", token)
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNoContent {
		return nil
	}
	var envelope struct {
		Data  json.RawMessage `json:"data"`
		Error *struct {
			Code    string            `json:"code"`
			Message string            `json:"message"`
			Fields  map[string]string `json:"fields"`
		} `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&envelope); err != nil {
		return fmt.Errorf("%s: %s: %w", url, res.Status, err)
	}
	if envelope.Error != nil {
		e := errs.New(envelope.Error.Code, envelope.Error.Message)
		for field, msg := range envelope.Error.Fields {
			e.Fields = append(e.Fields, errs.FieldError{Field: field, Message: msg})
		}
		return e
	}
	if res.StatusCode >= 300 {
		return fmt.Errorf("%s: %s", url, res.Status)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(envelope.Data, out)
}
