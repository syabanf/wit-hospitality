package guest

import (
	"context"
	"net/http"
)

// Finder is who logs a find through LostFound: the signed-in user of the calling context, with
// the villa scope the guest context checks.
type Finder struct {
	UserID      string   `json:"userId"`
	Name        string   `json:"name"`
	Role        string   `json:"role"`
	VillaIDs    []string `json:"villaIds"`
	LocationIDs []string `json:"locationIds"`
}

// LostFind is a find another context reports, as LostItemInput without photos, guest or storage.
type LostFind struct {
	FoundOn     string  `json:"foundOn"`
	VillaID     string  `json:"villaId"`
	UnitID      *string `json:"unitId"`
	Where       string  `json:"where"`
	Description string  `json:"description"`
	BookingID   *string `json:"bookingId"`
}

// LostFound logs a find in the finder's name, the mock's logFind: housekeeping calls it when an
// attendant notes something left in a room. It checks the villa scope and the unit and stay as
// POST /lost-found does, but not guest/create, since the caller already checked its own module.
type LostFound interface {
	LogFind(ctx context.Context, finder Finder, find LostFind) (LostItemEvent, error)
}

// LogFind calls POST /internal/v1/lost-found/finds.
func (h HTTPClient) LogFind(ctx context.Context, finder Finder, find LostFind) (LostItemEvent, error) {
	var out LostItemEvent
	err := h.call(ctx, http.MethodPost, "/internal/v1/lost-found/finds", map[string]any{"finder": finder, "find": find}, &out)
	return out, err
}
