// Package domain holds the files context's rules, ported from src/domain/attachment.ts.
package domain

import (
	"fmt"
	"slices"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// MaxBytes is MAX_ATTACHMENT_BYTES: 5 MB.
const MaxBytes = 5 * 1024 * 1024

// Types is ATTACHMENT_TYPES: photos and PDFs.
var Types = []string{"image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"}

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

// UploadProblem is uploadProblem: why a file cannot be stored, or nil.
func UploadProblem(name, contentType string, size int64) error {
	if !slices.Contains(Types, contentType) {
		return errs.New("ATTACHMENT_TYPE", fmt.Sprintf("%s is not a photo or a PDF.", name))
	}
	if size <= 0 {
		return errs.New("ATTACHMENT_EMPTY", fmt.Sprintf("%s is empty.", name))
	}
	if size > MaxBytes {
		return errs.New("ATTACHMENT_SIZE", fmt.Sprintf("%s is over 5 MB.", name))
	}
	return nil
}
