// Package clients adapts other contexts' published clients to the ports property's commands and
// queries declare.
package clients

import (
	"context"
	"io"

	"github.com/syabanf/wit-hospitality/api/internal/files"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/property/app/command"
)

// Files answers command.Uploads and query.Files from the files client: the module in process,
// files.HTTPClient to FILES_URL in split mode.
type Files struct{ Client files.Client }

// Upload looks one upload up; an id no upload has is not found rather than an error.
func (f Files) Upload(ctx context.Context, id string) (command.Upload, bool, error) {
	list, err := f.Client.Attachments(ctx, []string{id})
	if errs.HasCode(err, errs.CodeNotFound) {
		return command.Upload{}, false, nil
	}
	if err != nil || len(list) == 0 {
		return command.Upload{}, false, err
	}
	return command.Upload{ID: list[0].ID, Name: list[0].Name, Type: list[0].Type}, true, nil
}

// Open streams one upload; an id no upload has is not found rather than an error.
func (f Files) Open(ctx context.Context, id string) (io.ReadCloser, string, bool, error) {
	body, kind, err := f.Client.Open(ctx, id)
	if errs.HasCode(err, errs.CodeNotFound) {
		return nil, "", false, nil
	}
	if err != nil {
		return nil, "", false, err
	}
	return body, kind, true, nil
}
