// Package stays answers property's questions about stays. The booking context owns stays and
// arrives in phase 1; until then the API's database holds no stay, so None answers truthfully
// that nothing overlaps, nothing is upcoming and nothing waits for a room. Phase 1 adds an
// in-process client for the monolith and an HTTP client for split mode behind the same
// command.Stays interface.
package stays

import "context"

// None reports no stays.
type None struct{}

// OverlappingStay finds nothing.
func (None) OverlappingStay(context.Context, string, string, string) (string, bool, error) {
	return "", false, nil
}

// HasUpcomingStays finds nothing.
func (None) HasUpcomingStays(context.Context, string, string) (bool, error) { return false, nil }

// WaitingForRoom finds nothing.
func (None) WaitingForRoom(context.Context, string) ([]string, error) { return nil, nil }
