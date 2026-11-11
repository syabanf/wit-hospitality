// Package httpx holds the HTTP conventions of the /api/v1 contract: success as `{ data }`, failure
// as `{ error: { code, message } }` with the status taken from the domain code, 204 for empty
// answers, request ids, panic recovery, CORS for the Vite dev origin with credentials, and JSON
// decoding that reports bad bodies as VALIDATION_ERROR.
package httpx

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Problem is the error body.
type Problem struct {
	Error ProblemBody `json:"error"`
}

// ProblemBody carries the code the front end turns into a RuleError.
type ProblemBody struct {
	Code    string            `json:"code"`
	Message string            `json:"message"`
	Fields  map[string]string `json:"fields,omitempty"`
}

// statusByCode maps codes whose status is not 409.
var statusByCode = map[string]int{
	errs.CodeValidation:      http.StatusUnprocessableEntity,
	errs.CodeUnauthenticated: http.StatusUnauthorized,
	"INVALID_CREDENTIALS":    http.StatusUnauthorized,
	errs.CodeForbidden:       http.StatusForbidden,
	"USER_INACTIVE":          http.StatusForbidden,
	"ACCESS_OWNER":           http.StatusForbidden,
	errs.CodeNotFound:        http.StatusNotFound,
	"METHOD_NOT_ALLOWED":     http.StatusMethodNotAllowed,
	"PAYLOAD_TOO_LARGE":      http.StatusRequestEntityTooLarge,
	errs.CodeInternal:        http.StatusInternalServerError,
}

// StatusFor returns the HTTP status of a domain code. Every other business rule refusal
// (BOOKING_OVERLAP, UNIT_IN_USE, ACCESS_SELF, ...) is a 409 Conflict.
func StatusFor(code string) int {
	if s, ok := statusByCode[code]; ok {
		return s
	}
	if strings.HasSuffix(code, "_FORBIDDEN") {
		return http.StatusForbidden
	}
	return http.StatusConflict
}

// JSON writes `{ "data": v }`.
func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(struct {
		Data any `json:"data"`
	}{v})
}

// OK writes 200 with data.
func OK(w http.ResponseWriter, v any) { JSON(w, http.StatusOK, v) }

// Created writes 201 with data.
func Created(w http.ResponseWriter, v any) { JSON(w, http.StatusCreated, v) }

// NoContent writes 204, which the client reads as undefined.
func NoContent(w http.ResponseWriter) { w.WriteHeader(http.StatusNoContent) }

// WriteError answers with the problem body. Unknown errors become INTERNAL and are logged.
func WriteError(w http.ResponseWriter, r *http.Request, log *slog.Logger, err error) {
	e, ok := errs.As(err)
	if !ok {
		log.ErrorContext(r.Context(), "request failed", slog.String("method", r.Method), slog.String("path", r.URL.Path), slog.String("error", err.Error()))
		e = errs.New(errs.CodeInternal, "Something went wrong on our side. Try again.")
	}
	body := Problem{Error: ProblemBody{Code: e.Code, Message: e.Message}}
	if len(e.Fields) > 0 {
		body.Error.Fields = errs.Fields(e.Fields).Map()
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(StatusFor(e.Code))
	_ = json.NewEncoder(w).Encode(body)
}

// HandlerFunc returns an error instead of writing one.
type HandlerFunc func(w http.ResponseWriter, r *http.Request) error

// Handle adapts a HandlerFunc, writing its error as a problem.
func Handle(log *slog.Logger, h HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := h(w, r); err != nil {
			WriteError(w, r, log, err)
		}
	}
}

// MaxBody caps request bodies at 1 MiB; uploads set their own limit.
const MaxBody = 1 << 20

// Decode reads a JSON body into v. A malformed body is a VALIDATION_ERROR.
func Decode(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, MaxBody+1))
	if err := dec.Decode(v); err != nil {
		if errors.Is(err, io.EOF) {
			return errs.New(errs.CodeValidation, "The request body is empty.")
		}
		var typeErr *json.UnmarshalTypeError
		if errors.As(err, &typeErr) {
			return errs.Invalid(typeErr.Field, "The field "+typeErr.Field+" has the wrong type.")
		}
		return errs.New(errs.CodeValidation, "The request body is not valid JSON.")
	}
	return nil
}
