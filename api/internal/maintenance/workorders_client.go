package maintenance

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Reporter is who reports a work order through WorkOrders: the signed-in user of the calling
// context, with the villa scope maintenance checks.
type Reporter struct {
	UserID      string   `json:"userId"`
	Name        string   `json:"name"`
	Role        string   `json:"role"`
	VillaIDs    []string `json:"villaIds"`
	LocationIDs []string `json:"locationIds"`
}

// Report is a job another context asks maintenance to open, such as housekeeping's failed
// inspection or an issue an attendant found during a task.
type Report struct {
	VillaID     string `json:"villaId"`
	UnitID      string `json:"unitId"`
	Source      string `json:"source"`
	Category    string `json:"category"`
	Priority    string `json:"priority"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

// WorkOrderRef is the opened work order.
type WorkOrderRef struct {
	ID     string `json:"id"`
	Number string `json:"number"`
}

// WorkOrders opens a work order in the reporter's name, the mock's newWorkOrder. It checks the
// villa scope, the unit and the form as POST /work-orders does, but not maintenance/create, since
// the caller already checked its own module. The composition root hands a consumer the in-process
// implementation (maintenance/module) in the monolith and HTTPClient in split mode.
type WorkOrders interface {
	Open(ctx context.Context, by Reporter, r Report) (WorkOrderRef, error)
}

// HTTPClient calls the maintenance service's /internal/v1 routes with the shared INTERNAL_TOKEN.
type HTTPClient struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

// Open calls POST /internal/v1/work-orders/reports.
func (h HTTPClient) Open(ctx context.Context, by Reporter, r Report) (WorkOrderRef, error) {
	raw, err := json.Marshal(map[string]any{"reporter": by, "report": r})
	if err != nil {
		return WorkOrderRef{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.BaseURL+"/internal/v1/work-orders/reports", bytes.NewReader(raw))
	if err != nil {
		return WorkOrderRef{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", h.Token)
	client := h.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return WorkOrderRef{}, err
	}
	defer res.Body.Close()
	var envelope struct {
		Data  WorkOrderRef `json:"data"`
		Error *struct {
			Code    string            `json:"code"`
			Message string            `json:"message"`
			Fields  map[string]string `json:"fields"`
		} `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&envelope); err != nil {
		return WorkOrderRef{}, fmt.Errorf("maintenance work-orders/reports: %s: %w", res.Status, err)
	}
	if envelope.Error != nil {
		e := errs.New(envelope.Error.Code, envelope.Error.Message)
		for field, msg := range envelope.Error.Fields {
			e.Fields = append(e.Fields, errs.FieldError{Field: field, Message: msg})
		}
		return WorkOrderRef{}, e
	}
	if res.StatusCode >= 300 {
		return WorkOrderRef{}, fmt.Errorf("maintenance work-orders/reports: %s", res.Status)
	}
	return envelope.Data, nil
}
