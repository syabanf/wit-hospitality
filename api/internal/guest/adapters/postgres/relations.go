package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Complaint loads and locks a complaint.
func (r Repo) Complaint(ctx context.Context, id string) (domain.Complaint, error) {
	var c domain.Complaint
	err := loadDoc(r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM guest.complaints WHERE id = $1 FOR UPDATE`, id), &c, &c.Version)
	return c, notFound(err, "complaint", id)
}

// InsertComplaint adds a complaint at version 1.
func (r Repo) InsertComplaint(ctx context.Context, c *domain.Complaint) error {
	c.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO guest.complaints (id, number, villa_id, guest_id, booking_id, doc, version) VALUES ($1, $2, $3, $4, $5, $6, 1)`,
		c.ID, c.Number, c.VillaID, c.GuestID, c.BookingID, c)
	return err
}

// UpdateComplaint saves when the version matches.
func (r Repo) UpdateComplaint(ctx context.Context, c *domain.Complaint) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE guest.complaints SET villa_id = $2, guest_id = $3, booking_id = $4, doc = $5, version = version + 1 WHERE id = $1 AND version = $6`,
		c.ID, c.VillaID, c.GuestID, c.BookingID, c, c.Version)
	if err := stale(tag, err, "complaint"); err != nil {
		return err
	}
	c.Version++
	return nil
}

// Incident loads and locks an incident.
func (r Repo) Incident(ctx context.Context, id string) (domain.Incident, error) {
	var i domain.Incident
	err := loadDoc(r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM guest.incidents WHERE id = $1 FOR UPDATE`, id), &i, &i.Version)
	return i, notFound(err, "incident", id)
}

// InsertIncident adds an incident at version 1.
func (r Repo) InsertIncident(ctx context.Context, i *domain.Incident) error {
	i.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO guest.incidents (id, number, villa_id, doc, version) VALUES ($1, $2, $3, $4, 1)`, i.ID, i.Number, i.VillaID, i)
	return err
}

// UpdateIncident saves when the version matches.
func (r Repo) UpdateIncident(ctx context.Context, i *domain.Incident) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE guest.incidents SET villa_id = $2, doc = $3, version = version + 1 WHERE id = $1 AND version = $4`, i.ID, i.VillaID, i, i.Version)
	if err := stale(tag, err, "incident"); err != nil {
		return err
	}
	i.Version++
	return nil
}

// SafeBox loads and locks a box.
func (r Repo) SafeBox(ctx context.Context, id string) (domain.SafeBox, error) {
	var b domain.SafeBox
	err := loadDoc(r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM guest.safe_boxes WHERE id = $1 FOR UPDATE`, id), &b, &b.Version)
	return b, notFound(err, "safe box", id)
}

// SafeBoxesOf lists a villa's boxes.
func (r Repo) SafeBoxesOf(ctx context.Context, villaID string) ([]domain.SafeBox, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT doc FROM guest.safe_boxes WHERE villa_id = $1 ORDER BY seq`, villaID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, docRow[domain.SafeBox])
}

// InsertSafeBox adds a box at version 1.
func (r Repo) InsertSafeBox(ctx context.Context, b *domain.SafeBox) error {
	b.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO guest.safe_boxes (id, villa_id, doc, version) VALUES ($1, $2, $3, 1)`, b.ID, b.VillaID, b)
	return err
}

// UpdateSafeBox saves when the version matches.
func (r Repo) UpdateSafeBox(ctx context.Context, b *domain.SafeBox) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE guest.safe_boxes SET doc = $2, version = version + 1 WHERE id = $1 AND version = $3`, b.ID, b, b.Version)
	if err := stale(tag, err, "safe box"); err != nil {
		return err
	}
	b.Version++
	return nil
}

// BoxRental loads and locks a box rental.
func (r Repo) BoxRental(ctx context.Context, id string) (domain.BoxRental, error) {
	var b domain.BoxRental
	err := loadDoc(r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM guest.box_rentals WHERE id = $1 FOR UPDATE`, id), &b, &b.Version)
	return b, notFound(err, "safe box rental", id)
}

// InsertBoxRental adds a rental at version 1.
func (r Repo) InsertBoxRental(ctx context.Context, b *domain.BoxRental) error {
	b.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO guest.box_rentals (id, number, box_id, villa_id, booking_id, guest_id, doc, version) VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
		b.ID, b.Number, b.BoxID, b.VillaID, b.BookingID, b.GuestID, b)
	return err
}

// UpdateBoxRental saves when the version matches.
func (r Repo) UpdateBoxRental(ctx context.Context, b *domain.BoxRental) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE guest.box_rentals SET guest_id = $2, doc = $3, version = version + 1 WHERE id = $1 AND version = $4`, b.ID, b.GuestID, b, b.Version)
	if err := stale(tag, err, "safe box rental"); err != nil {
		return err
	}
	b.Version++
	return nil
}

// MoveRelations gives the dropped guest's complaints, box rentals and places in incidents to the
// kept guest.
func (r Repo) MoveRelations(ctx context.Context, dropID, keepID string) error {
	q := r.DB.Q(ctx)
	if _, err := q.Exec(ctx, `UPDATE guest.complaints SET guest_id = $2, doc = jsonb_set(doc, '{guestId}', to_jsonb($2::text)), version = version + 1 WHERE guest_id = $1`, dropID, keepID); err != nil {
		return err
	}
	if _, err := q.Exec(ctx, `UPDATE guest.box_rentals SET guest_id = $2, doc = jsonb_set(doc, '{guestId}', to_jsonb($2::text)), version = version + 1 WHERE guest_id = $1`, dropID, keepID); err != nil {
		return err
	}
	_, err := q.Exec(ctx, `
		UPDATE guest.incidents SET version = version + 1, doc = jsonb_set(doc, '{people}', (
			SELECT jsonb_agg(CASE WHEN p->>'guestId' = $1 THEN jsonb_set(p, '{guestId}', to_jsonb($2::text)) ELSE p END ORDER BY n)
			FROM jsonb_array_elements(doc->'people') WITH ORDINALITY AS e(p, n)))
		WHERE doc->'people' @> jsonb_build_array(jsonb_build_object('guestId', $1::text))`, dropID, keepID)
	return err
}

func scopedDocs[T any](ctx context.Context, s ReadStore, view string, sc rbac.Scope) ([]T, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT doc FROM guest.`+view+` WHERE `+inScope+` ORDER BY seq`, args(sc)...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, docRow[T])
}

// Complaints returns the complaints of villas in scope.
func (s ReadStore) Complaints(ctx context.Context, sc rbac.Scope) ([]domain.Complaint, error) {
	return scopedDocs[domain.Complaint](ctx, s, "v_complaints", sc)
}

// Incidents returns the incidents of villas in scope.
func (s ReadStore) Incidents(ctx context.Context, sc rbac.Scope) ([]domain.Incident, error) {
	return scopedDocs[domain.Incident](ctx, s, "v_incidents", sc)
}

// SafeBoxes returns the boxes of villas in scope.
func (s ReadStore) SafeBoxes(ctx context.Context, sc rbac.Scope) ([]domain.SafeBox, error) {
	return scopedDocs[domain.SafeBox](ctx, s, "v_safe_boxes", sc)
}

// BoxRentals returns the box rentals of villas in scope.
func (s ReadStore) BoxRentals(ctx context.Context, sc rbac.Scope) ([]domain.BoxRental, error) {
	return scopedDocs[domain.BoxRental](ctx, s, "v_box_rentals", sc)
}
