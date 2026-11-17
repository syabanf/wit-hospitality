-- +goose Up
-- Card holds taken as a stay's security deposit (booking_id the stay) and the front office log
-- book (villa_id the property an entry is about, empty for every property; ref the cashier shift
-- that wrote a handover). Both keep the console's JSON in doc like the other record tables.
CREATE TABLE billing.pre_auths (LIKE billing.postings INCLUDING ALL);
CREATE TABLE billing.log_entries (LIKE billing.postings INCLUDING ALL);

-- +goose Down
DROP TABLE billing.log_entries;
DROP TABLE billing.pre_auths;
