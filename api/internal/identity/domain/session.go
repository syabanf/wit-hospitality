package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"time"
)

// RefreshToken is one link in a session's rotation chain. Only the hash is stored.
type RefreshToken struct {
	ID        string
	SessionID string
	UserID    string
	Hash      string
	ExpiresAt time.Time
	RotatedAt *time.Time
	RevokedAt *time.Time
}

// RotationGrace lets requests that left the browser together with the old token through after the
// first of them rotated it: the page fires several calls at once and each carries the same cookie.
const RotationGrace = 30 * time.Second

// Refresh decisions.
type RefreshDecision int

const (
	// Rotate: issue a new refresh token and retire this one.
	Rotate RefreshDecision = iota
	// Reuse: a sibling request rotated it moments ago; issue an access token only.
	Reuse
	// Reject: expired or revoked.
	Reject
	// Theft: an old token came back after the grace window; revoke the whole session.
	Theft
)

// Decide applies the rotation rules.
func (t RefreshToken) Decide(now time.Time) RefreshDecision {
	switch {
	case t.RevokedAt != nil || !now.Before(t.ExpiresAt):
		return Reject
	case t.RotatedAt == nil:
		return Rotate
	case now.Sub(*t.RotatedAt) <= RotationGrace:
		return Reuse
	default:
		return Theft
	}
}

// HashToken is how refresh tokens are stored and looked up.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
