package module_test

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/files"
	"github.com/syabanf/wit-hospitality/api/internal/files/module"
	"github.com/syabanf/wit-hospitality/api/internal/files/storage"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
)

func upload(t *testing.T, h http.Handler, name, kind string, data []byte) files.Attachment {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, _ := w.CreatePart(textproto.MIMEHeader{"Content-Disposition": {`form-data; name="file"; filename="` + name + `"`}, "Content-Type": {kind}})
	_, _ = part.Write(data)
	_ = w.Close()
	req := httptest.NewRequest("POST", "/files", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var out struct{ Data files.Attachment }
	if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &out) != nil {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body)
	}
	return out.Data
}

// An upload resolves by id in process and through the internal route the HTTP client calls; a
// file stored before attachments were kept beside it still resolves from its bytes.
func TestAttachmentsResolveByID(t *testing.T) {
	store := storage.Local{Dir: t.TempDir()}
	m := module.New(module.Deps{Storage: store, Clock: clock.Fixed{T: time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC)}, Log: logging.Discard(), PublicURL: "http://files.test/api/v1/"})
	r := chi.NewRouter()
	m.Routes(r)
	r.Route("/internal/v1", func(r chi.Router) {
		r.Use(httpx.InternalOnly("internal", logging.Discard()))
		m.InternalRoutes(r)
	})
	pdf := []byte("%PDF-1.4\n")
	a := upload(t, r, "invoice.pdf", "application/pdf", pdf)
	ctx := context.Background()
	if err := store.Put(ctx, "file-old", "image/png", []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}

	got, err := m.Client().Attachments(ctx, []string{a.ID, "file-old"})
	if err != nil {
		t.Fatal(err)
	}
	old := files.Attachment{ID: "file-old", Name: "file-old", Type: "image/png", Size: 3, URL: "http://files.test/api/v1/files/file-old"}
	if len(got) != 2 || got[0] != a || got[1] != old || a.Name != "invoice.pdf" || a.UploadedBy != "Guest" {
		t.Fatalf("in process %+v", got)
	}
	if _, err := m.Attachments(ctx, []string{a.ID + ".meta"}); !errs.HasCode(err, errs.CodeNotFound) {
		t.Fatalf("the stored attachment is no file: %v", err)
	}

	srv := httptest.NewServer(r)
	defer srv.Close()
	c := files.HTTPClient{BaseURL: srv.URL, Token: "internal"}
	if got, err := c.Attachments(ctx, []string{a.ID}); err != nil || len(got) != 1 || got[0] != a {
		t.Fatalf("over HTTP %+v %v", got, err)
	}
	if got, err := c.Attachments(ctx, nil); err != nil || len(got) != 0 {
		t.Fatalf("no ids %+v %v", got, err)
	}
	if _, err := c.Attachments(ctx, []string{"file-gone"}); !errs.HasCode(err, errs.CodeNotFound) {
		t.Fatalf("an unknown id: %v", err)
	}
	if _, err := (files.HTTPClient{BaseURL: srv.URL, Token: "wrong"}).Attachments(ctx, []string{a.ID}); !errs.HasCode(err, errs.CodeForbidden) {
		t.Fatalf("without the token: %v", err)
	}
}
