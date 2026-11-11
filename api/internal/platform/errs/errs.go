// Package errs carries the error codes the front end shows. A domain rule returns an *Error with
// the same code as the TypeScript RuleError (VALIDATION_ERROR, FORBIDDEN, UNIT_IN_USE, ...);
// httpx turns it into `{ error: { code, message } }` with a matching HTTP status.
package errs

import (
	"errors"
	"fmt"
)

// FieldError is one form field and the message the front end shows under it.
type FieldError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// Error is a refusal with a stable code.
type Error struct {
	Code    string
	Message string
	// Fields lists every field error, in the order the TypeScript validators report them.
	Fields []FieldError
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// New returns a rule refusal.
func New(code, message string) *Error { return &Error{Code: code, Message: message} }

// Newf formats the message.
func Newf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// NotFound mirrors the front end's NotFoundError text.
func NotFound(what, id string) *Error {
	return &Error{Code: CodeNotFound, Message: fmt.Sprintf("No %s with id %q", what, id)}
}

// Unauthenticated is the refusal for a request without a session.
func Unauthenticated() *Error {
	return &Error{Code: CodeUnauthenticated, Message: "Sign in to continue."}
}

// Forbidden is a permission refusal.
func Forbidden(message string) *Error { return &Error{Code: CodeForbidden, Message: message} }

// As returns the *Error inside err.
func As(err error) (*Error, bool) {
	var e *Error
	ok := errors.As(err, &e)
	return e, ok
}

// HasCode reports whether err carries code.
func HasCode(err error, code string) bool {
	e, ok := As(err)
	return ok && e.Code == code
}

// Codes shared by every context.
const (
	CodeValidation      = "VALIDATION_ERROR"
	CodeNotFound        = "NOT_FOUND"
	CodeUnauthenticated = "UNAUTHENTICATED"
	CodeForbidden       = "FORBIDDEN"
	CodeConflict        = "CONCURRENT_UPDATE"
	CodeInternal        = "INTERNAL"
)

// Fields collects field errors in order. The first one becomes the message, as the mock's
// `refuse` does.
type Fields []FieldError

// Add appends a field error.
func (f *Fields) Add(field, message string) {
	*f = append(*f, FieldError{Field: field, Message: message})
}

// Has reports whether field already has an error.
func (f Fields) Has(field string) bool {
	for _, e := range f {
		if e.Field == field {
			return true
		}
	}
	return false
}

// Map returns the errors keyed by field, the shape the TypeScript validators return.
func (f Fields) Map() map[string]string {
	m := make(map[string]string, len(f))
	for _, e := range f {
		m[e.Field] = e.Message
	}
	return m
}

// Err returns nil without errors, else a VALIDATION_ERROR whose message is the first error.
func (f Fields) Err() error {
	if len(f) == 0 {
		return nil
	}
	return &Error{Code: CodeValidation, Message: f[0].Message, Fields: f}
}

// Invalid is a VALIDATION_ERROR on one field.
func Invalid(field, message string) *Error {
	return &Error{Code: CodeValidation, Message: message, Fields: []FieldError{{Field: field, Message: message}}}
}
