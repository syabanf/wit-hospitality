// Package module wires the files context: POST /files stores an upload in the configured storage
// and answers the Attachment the console keeps; GET /files/{id} serves it back to a signed-in user.
// Files keeps no records of its own: the context that attaches a file stores the Attachment on its
// record, so files has no schema.
package module

import (
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/files/domain"
	"github.com/syabanf/wit-hospitality/api/internal/files/storage"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
)

// Deps is what the files context needs from the process.
type Deps struct {
	Storage storage.Storage
	Clock   clock.Clock
	Log     *slog.Logger
	// PublicURL is the API base the console opens files from (FILES_PUBLIC_URL, by default
	// http://localhost:8080/api/v1); an attachment's url is PublicURL/files/{id}.
	PublicURL string
}

// Module is the wired context.
type Module struct{ d Deps }

// New wires the files context.
func New(d Deps) *Module {
	d.PublicURL = strings.TrimRight(d.PublicURL, "/")
	return &Module{d: d}
}

// Routes registers the public routes.
func (m *Module) Routes(r chi.Router) {
	r.Post("/files", httpx.Handle(m.d.Log, m.upload))
	r.Get("/files/{id}", httpx.Handle(m.d.Log, m.serve))
}

// upload reads the multipart part "file". Anyone may upload, as in the mock: a guest sends a
// payment proof without a session, and the attachment names them Guest.
func (m *Module) upload(w http.ResponseWriter, r *http.Request) error {
	by := "Guest"
	if p, ok := auth.FromContext(r.Context()); ok {
		by = p.Name
	}
	r.Body = http.MaxBytesReader(w, r.Body, domain.MaxBytes+1<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		return errs.New(errs.CodeValidation, "Send the file as multipart form data in the field file.")
	}
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			return errs.New(errs.CodeValidation, "Send the file as multipart form data in the field file.")
		}
		if err != nil {
			return tooLarge(err)
		}
		if part.FormName() != "file" {
			continue
		}
		name := part.FileName()
		if name == "" {
			name = "file"
		}
		data, err := io.ReadAll(io.LimitReader(part, domain.MaxBytes+1))
		if err != nil {
			return tooLarge(err)
		}
		kind, _, _ := mime.ParseMediaType(part.Header.Get("Content-Type"))
		if kind == "" || kind == "application/octet-stream" {
			kind, _, _ = mime.ParseMediaType(http.DetectContentType(data))
		}
		if err := domain.UploadProblem(name, kind, int64(len(data))); err != nil {
			return err
		}
		a := domain.Attachment{ID: ids.Random("file"), Name: name, Type: kind, Size: int64(len(data)), UploadedBy: by, UploadedAt: clock.Stamp(m.d.Clock)}
		a.URL = m.d.PublicURL + "/files/" + a.ID
		if err := m.d.Storage.Put(r.Context(), a.ID, kind, data); err != nil {
			return err
		}
		httpx.Created(w, a)
		return nil
	}
}

func tooLarge(err error) error {
	var max *http.MaxBytesError
	if errors.As(err, &max) {
		return errs.New("ATTACHMENT_SIZE", "The file is over 5 MB.")
	}
	return errs.New(errs.CodeValidation, "The upload could not be read.")
}

func (m *Module) serve(w http.ResponseWriter, r *http.Request) error {
	if _, err := auth.Require(r.Context()); err != nil {
		return err
	}
	id := chi.URLParam(r, "id")
	body, kind, err := m.d.Storage.Get(r.Context(), id)
	if errors.Is(err, storage.ErrNotFound) {
		return errs.NotFound("file", id)
	}
	if err != nil {
		return err
	}
	defer body.Close()
	w.Header().Set("Content-Type", kind)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, err = io.Copy(w, body)
	return err
}
