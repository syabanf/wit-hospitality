// Package postgres implements the channel context's write repository, catalog reads, read store,
// projections of property events and seed loader on the channel schema.
package postgres

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/syabanf/wit-hospitality/api/internal/channel/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrations is the channel context's migration set.
func Migrations() migrations.Set {
	sub, _ := fs.Sub(migrationFS, "migrations")
	return migrations.Set{Schema: "channel", FS: sub}
}

// Repo is the write repository and the catalog reader.
type Repo struct{ DB *db.DB }

func notFound(err error, what, id string) error {
	if db.NoRows(err) {
		return errs.NotFound(what, id)
	}
	return err
}

func stale(tag pgconn.CommandTag, err error, what string) error {
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errs.Newf(errs.CodeConflict, "Someone else changed this %s. Reload and try again.", what)
	}
	return nil
}

// unique maps a unique violation, which a parallel save can hit after validation passed, to the
// validator's message.
func unique(err error) error {
	constraint, dup := db.UniqueViolation(err)
	if !dup {
		return err
	}
	switch constraint {
	case "listings_unit_id_key":
		return errs.Invalid("unitId", "That unit already has a listing.")
	case "listings_airbnb_id_key":
		return errs.Invalid("airbnbId", "That listing id is already on file.")
	case "airbnb_accounts_name":
		return errs.Invalid("name", "That host account already exists.")
	}
	return err
}

func exists(ctx context.Context, d *db.DB, sql string, args ...any) (bool, error) {
	var found bool
	err := d.Q(ctx).QueryRow(ctx, `SELECT EXISTS (`+sql+`)`, args...).Scan(&found)
	return found, err
}

// Account loads and locks a host account.
func (r Repo) Account(ctx context.Context, id string) (domain.Account, error) {
	var a domain.Account
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, name, email, status, slot, version FROM channel.airbnb_accounts WHERE id = $1 FOR UPDATE`, id).
		Scan(&a.ID, &a.Name, &a.Email, &a.Status, &a.Slot, &a.Version)
	return a, notFound(err, "Airbnb account", id)
}

// AccountNameTaken reports another account with the trimmed name, ignoring case.
func (r Repo) AccountNameTaken(ctx context.Context, name, excludeID string) (bool, error) {
	return exists(ctx, r.DB, `SELECT 1 FROM channel.airbnb_accounts WHERE lower(name) = lower(btrim($1)) AND id <> $2`, name, excludeID)
}

// CountAccounts counts the host accounts.
func (r Repo) CountAccounts(ctx context.Context) (int, error) {
	var n int
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT count(*) FROM channel.airbnb_accounts`).Scan(&n)
	return n, err
}

// InsertAccount adds an account at version 1.
func (r Repo) InsertAccount(ctx context.Context, a *domain.Account) error {
	a.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO channel.airbnb_accounts (id, name, email, status, slot, version) VALUES ($1, $2, $3, $4, $5, $6)`,
		a.ID, a.Name, a.Email, a.Status, a.Slot, a.Version)
	return unique(err)
}

// UpdateAccount saves when the version matches.
func (r Repo) UpdateAccount(ctx context.Context, a *domain.Account) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE channel.airbnb_accounts SET name = $2, email = $3, status = $4, version = version + 1 WHERE id = $1 AND version = $5`,
		a.ID, a.Name, a.Email, a.Status, a.Version)
	if err := stale(tag, unique(err), "Airbnb account"); err != nil {
		return err
	}
	a.Version++
	return nil
}

// Listing loads and locks a listing.
func (r Repo) Listing(ctx context.Context, id string) (domain.Listing, error) {
	var l domain.Listing
	var rates []byte
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, account_id, unit_id, title, airbnb_id, status, date_rates, version FROM channel.listings WHERE id = $1 FOR UPDATE`, id).
		Scan(&l.ID, &l.AccountID, &l.UnitID, &l.Title, &l.AirbnbID, &l.Status, &rates, &l.Version)
	if err != nil {
		return l, notFound(err, "listing", id)
	}
	return l, json.Unmarshal(rates, &l.DateRates)
}

// ListingUnitTaken reports another listing on the unit.
func (r Repo) ListingUnitTaken(ctx context.Context, unitID, excludeID string) (bool, error) {
	return exists(ctx, r.DB, `SELECT 1 FROM channel.listings WHERE unit_id = $1 AND id <> $2`, unitID, excludeID)
}

// ListingAirbnbIDTaken reports another listing with the Airbnb id.
func (r Repo) ListingAirbnbIDTaken(ctx context.Context, airbnbID, excludeID string) (bool, error) {
	return exists(ctx, r.DB, `SELECT 1 FROM channel.listings WHERE airbnb_id = $1 AND id <> $2`, airbnbID, excludeID)
}

// ListingIDTaken reports a listing with the id.
func (r Repo) ListingIDTaken(ctx context.Context, id string) (bool, error) {
	return exists(ctx, r.DB, `SELECT 1 FROM channel.listings WHERE id = $1`, id)
}

func ratesJSON(rates map[string]int64) ([]byte, error) {
	if rates == nil {
		rates = map[string]int64{}
	}
	return json.Marshal(rates)
}

// InsertListing adds a listing at version 1.
func (r Repo) InsertListing(ctx context.Context, l *domain.Listing) error {
	rates, err := ratesJSON(l.DateRates)
	if err != nil {
		return err
	}
	l.Version = 1
	_, err = r.DB.Q(ctx).Exec(ctx, `INSERT INTO channel.listings (id, account_id, unit_id, title, airbnb_id, status, date_rates, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		l.ID, l.AccountID, l.UnitID, l.Title, l.AirbnbID, l.Status, rates, l.Version)
	return unique(err)
}

// UpdateListing saves when the version matches.
func (r Repo) UpdateListing(ctx context.Context, l *domain.Listing) error {
	rates, err := ratesJSON(l.DateRates)
	if err != nil {
		return err
	}
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE channel.listings SET account_id = $2, unit_id = $3, title = $4, airbnb_id = $5, status = $6, date_rates = $7, version = version + 1 WHERE id = $1 AND version = $8`,
		l.ID, l.AccountID, l.UnitID, l.Title, l.AirbnbID, l.Status, rates, l.Version)
	if err := stale(tag, unique(err), "listing"); err != nil {
		return err
	}
	l.Version++
	return nil
}

const enquiryColumns = `seq, id, number, topic, name, email, whatsapp, country, check_in, check_out, guests, villa_id, group_id, note,
	status, booking_id, created_on, created_at, handled_by, status_note, version`

func scanEnquiry(row pgx.Row) (domain.Enquiry, error) {
	var e domain.Enquiry
	err := row.Scan(&e.Seq, &e.ID, &e.Number, &e.Topic, &e.Name, &e.Email, &e.WhatsApp, &e.Country, &e.CheckIn, &e.CheckOut, &e.Guests, &e.VillaID, &e.GroupID, &e.Note,
		&e.Status, &e.BookingID, &e.CreatedOn, &e.CreatedAt, &e.HandledBy, &e.StatusNote, &e.Version)
	return e, err
}

// Enquiry loads and locks an enquiry.
func (r Repo) Enquiry(ctx context.Context, id string) (domain.Enquiry, error) {
	e, err := scanEnquiry(r.DB.Q(ctx).QueryRow(ctx, `SELECT `+enquiryColumns+` FROM channel.enquiries WHERE id = $1 FOR UPDATE`, id))
	return e, notFound(err, "enquiry", id)
}

// NextEnquirySeq takes the next enquiry number.
func (r Repo) NextEnquirySeq(ctx context.Context) (int64, error) {
	var n int64
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT nextval('channel.enquiry_seq')`).Scan(&n)
	return n, err
}

// InsertEnquiry adds an enquiry at version 1, at the top of the list.
func (r Repo) InsertEnquiry(ctx context.Context, e *domain.Enquiry) error {
	return r.insertEnquiry(ctx, e, e.Seq)
}

func (r Repo) insertEnquiry(ctx context.Context, e *domain.Enquiry, pos int64) error {
	e.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO channel.enquiries (`+enquiryColumns+`, pos) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
		e.Seq, e.ID, e.Number, e.Topic, e.Name, e.Email, e.WhatsApp, e.Country, e.CheckIn, e.CheckOut, e.Guests, e.VillaID, e.GroupID, e.Note,
		e.Status, e.BookingID, e.CreatedOn, e.CreatedAt, e.HandledBy, e.StatusNote, e.Version, pos)
	return err
}

// UpdateEnquiry saves the status fields when the version matches.
func (r Repo) UpdateEnquiry(ctx context.Context, e *domain.Enquiry) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE channel.enquiries SET status = $2, booking_id = $3, handled_by = $4, status_note = $5, version = version + 1 WHERE id = $1 AND version = $6`,
		e.ID, e.Status, e.BookingID, e.HandledBy, e.StatusNote, e.Version)
	if err := stale(tag, err, "enquiry"); err != nil {
		return err
	}
	e.Version++
	return nil
}

// Unit reads a projected unit; nil when property has not published it.
func (r Repo) Unit(ctx context.Context, id string) (*domain.Unit, error) {
	var u domain.Unit
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, villa_id, location_id, group_id, code, status, nightly_rate FROM channel.rm_units WHERE id = $1`, id).
		Scan(&u.ID, &u.VillaID, &u.LocationID, &u.GroupID, &u.Code, &u.Status, &u.NightlyRate)
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// Villa reads a projected villa; nil when unknown.
func (r Repo) Villa(ctx context.Context, id string) (*domain.Villa, error) {
	var v domain.Villa
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, location_id, name FROM channel.rm_villas WHERE id = $1`, id).Scan(&v.ID, &v.LocationID, &v.Name)
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &v, nil
}

// GroupVilla returns the villa of a projected room type, empty when unknown.
func (r Repo) GroupVilla(ctx context.Context, groupID string) (string, error) {
	var villa string
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT villa_id FROM channel.rm_unit_groups WHERE id = $1`, groupID).Scan(&villa)
	if db.NoRows(err) {
		return "", nil
	}
	return villa, err
}

// VillaTakesStays reports a unit of the villa, of the room type when given, that is not inactive.
func (r Repo) VillaTakesStays(ctx context.Context, villaID string, groupID *string) (bool, error) {
	group := ""
	if groupID != nil {
		group = *groupID
	}
	return exists(ctx, r.DB, `SELECT 1 FROM channel.rm_units WHERE villa_id = $1 AND status <> 'inactive' AND ($2 = '' OR group_id = $2)`, villaID, group)
}
