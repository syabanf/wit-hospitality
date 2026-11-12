// Package files is the published language of the files context: the Attachment an upload answers
// with and the client other contexts resolve uploaded files by id through. Other contexts may
// import this package and nothing below it.
package files

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Attachment is the record a file upload answers with; the context that keeps the file on one of
// its records stores this on that record.
type Attachment struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Type       string `json:"type"`
	Size       int64  `json:"size"`
	URL        string `json:"url"`
	UploadedBy string `json:"uploadedBy"`
	UploadedAt string `json:"uploadedAt"`
}

// Client resolves uploaded files by id. The composition root hands a consumer the in-process
// implementation (files/module) in the monolith and HTTPClient in split mode.
type Client interface {
	// Attachments returns the attachments in the order of ids; NOT_FOUND names the first id no
	// upload has.
	Attachments(ctx context.Context, ids []string) ([]Attachment, error)
}

// HTTPClient calls the files service's GET /internal/v1/files with INTERNAL_TOKEN.
type HTTPClient struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

// Attachments calls GET /internal/v1/files?id=...&id=....
func (h HTTPClient) Attachments(ctx context.Context, ids []string) ([]Attachment, error) {
	if len(ids) == 0 {
		return []Attachment{}, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.BaseURL+"/internal/v1/files?"+url.Values{"id": ids}.Encode(), nil)
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
		Data  []Attachment `json:"data"`
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&envelope); err != nil {
		return nil, fmt.Errorf("files GET /internal/v1/files: %s: %w", res.Status, err)
	}
	if envelope.Error != nil {
		return nil, errs.New(envelope.Error.Code, envelope.Error.Message)
	}
	if res.StatusCode >= 300 {
		return nil, fmt.Errorf("files GET /internal/v1/files: %s", res.Status)
	}
	return envelope.Data, nil
}
