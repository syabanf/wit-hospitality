package postgres

import "context"

// ClaimGuestPosting records the posting a guest request made; false when the source already has
// one.
func (s Store) ClaimGuestPosting(ctx context.Context, sourceID, postingID string) (bool, error) {
	tag, err := s.DB.Q(ctx).Exec(ctx, `INSERT INTO billing.guest_postings (source_id, posting_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, sourceID, postingID)
	return tag.RowsAffected() == 1, err
}
