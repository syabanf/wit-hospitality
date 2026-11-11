// Package auth signs and checks sessions. A session is a short JWT access token (15 minutes) plus
// an opaque refresh token that rotates on every use; both travel in httpOnly SameSite=Lax cookies
// because the front end's client sends `credentials: 'include'` and no Authorization header.
// The middleware renews an expired access token from the refresh cookie without a round trip,
// so the front end never sees the expiry.
package auth

import (
	"context"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Principal is the signed-in user as every context sees it.
type Principal struct {
	UserID      string    `json:"userId"`
	Name        string    `json:"name"`
	Email       string    `json:"email"`
	Role        rbac.Role `json:"role"`
	LocationIDs []string  `json:"locationIds"`
	VillaIDs    []string  `json:"villaIds"`
	EmployeeID  *string   `json:"employeeId"`
	SessionID   string    `json:"sessionId"`
}

// Scope returns the villa and location scope.
func (p Principal) Scope() rbac.Scope {
	return rbac.Scope{LocationIDs: p.LocationIDs, VillaIDs: p.VillaIDs}
}

type principalKey struct{}

// WithPrincipal stores p on ctx.
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}

// FromContext returns the principal, if any.
func FromContext(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	return p, ok
}

// Require returns the principal or UNAUTHENTICATED.
func Require(ctx context.Context) (Principal, error) {
	p, ok := FromContext(ctx)
	if !ok {
		return Principal{}, errs.Unauthenticated()
	}
	return p, nil
}

// Session is what a login or a refresh hands back.
type Session struct {
	Principal     Principal `json:"principal"`
	AccessToken   string    `json:"accessToken"`
	AccessExpires time.Time `json:"accessExpires"`
	// RefreshToken is empty when a request inside the rotation grace window reused the old token.
	RefreshToken   string    `json:"refreshToken,omitempty"`
	RefreshExpires time.Time `json:"refreshExpires"`
}

// Refresher turns a refresh token into a new session. Identity implements it; other services call
// identity through an HTTP Refresher in split mode.
type Refresher interface {
	Refresh(ctx context.Context, refreshToken string) (Session, error)
}

// Issuer signs and verifies access tokens with HS256.
type Issuer struct {
	Secret []byte
	TTL    time.Duration
}

type claims struct {
	jwt.RegisteredClaims
	Name        string    `json:"name"`
	Email       string    `json:"email"`
	Role        rbac.Role `json:"role"`
	LocationIDs []string  `json:"loc"`
	VillaIDs    []string  `json:"vil"`
	EmployeeID  *string   `json:"emp,omitempty"`
	SessionID   string    `json:"sid"`
}

const issuerName = "wit-hospitality"

// Issue signs an access token for p.
func (i Issuer) Issue(p Principal, now time.Time) (string, time.Time, error) {
	exp := now.Add(i.TTL)
	c := claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   p.UserID,
			Issuer:    issuerName,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(exp),
		},
		Name: p.Name, Email: p.Email, Role: p.Role, LocationIDs: p.LocationIDs, VillaIDs: p.VillaIDs,
		EmployeeID: p.EmployeeID, SessionID: p.SessionID,
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString(i.Secret)
	return signed, exp, err
}

// Verify checks the signature and expiry.
func (i Issuer) Verify(token string, now time.Time) (Principal, error) {
	var c claims
	_, err := jwt.ParseWithClaims(token, &c, func(t *jwt.Token) (any, error) {
		if t.Method != jwt.SigningMethodHS256 {
			return nil, fmt.Errorf("unexpected signing method %s", t.Method.Alg())
		}
		return i.Secret, nil
	}, jwt.WithIssuer(issuerName), jwt.WithTimeFunc(func() time.Time { return now }), jwt.WithExpirationRequired())
	if err != nil {
		return Principal{}, err
	}
	loc, vil := c.LocationIDs, c.VillaIDs
	if loc == nil {
		loc = []string{}
	}
	if vil == nil {
		vil = []string{}
	}
	return Principal{UserID: c.Subject, Name: c.Name, Email: c.Email, Role: c.Role, LocationIDs: loc, VillaIDs: vil, EmployeeID: c.EmployeeID, SessionID: c.SessionID}, nil
}
