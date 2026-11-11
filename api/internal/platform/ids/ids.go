// Package ids makes record ids in the front end's style: a prefix (usr-, vil-, grp-, unit-, blk-,
// aud-), a slug of the name where there is one, and a random tail instead of the mock's counter,
// so two services never hand out the same id.
package ids

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

const alphabet = "0123456789abcdefghjkmnpqrstvwxyz"

func tail(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b)
}

// Slug lowercases text and joins its words with dashes, like the mock's slug().
func Slug(text string) string {
	var sb strings.Builder
	dash := false
	for _, r := range strings.ToLower(text) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			sb.WriteRune(r)
			dash = false
			continue
		}
		if !dash && sb.Len() > 0 {
			sb.WriteByte('-')
			dash = true
		}
	}
	return strings.TrimSuffix(sb.String(), "-")
}

// New returns prefix-slug-tail, for example vil-villa-saka-7k2m9q.
func New(prefix, text string) string {
	s := Slug(text)
	if len(s) > 40 {
		s = strings.TrimSuffix(s[:40], "-")
	}
	if s == "" {
		s = "x"
	}
	return fmt.Sprintf("%s-%s-%s", prefix, s, tail(6))
}

// Random returns prefix-tail.
func Random(prefix string) string { return prefix + "-" + tail(10) }

// Sortable returns prefix-<unix millis base32>-tail, which sorts by creation time.
func Sortable(prefix string) string {
	return fmt.Sprintf("%s-%011s%s", prefix, toBase32(uint64(time.Now().UnixMilli())), tail(4))
}

func toBase32(v uint64) string {
	if v == 0 {
		return "0"
	}
	var out []byte
	for v > 0 {
		out = append([]byte{alphabet[v%32]}, out...)
		v /= 32
	}
	return string(out)
}

// UUID returns a random version 4 UUID.
func UUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// Token returns n random bytes as hex, for refresh tokens.
func Token(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
