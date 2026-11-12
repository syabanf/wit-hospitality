-- +goose Up
-- Where finance stands on each partner bill of a delivered order, kept from
-- finance.cash_out.decided.v1 (consumer services.finance). The order's costTransactionIds lists
-- these bills, and a void is refused once one of them is posted. version is finance's entry
-- version, so a late event cannot roll a status back.
CREATE TABLE services.partner_bills (
    transaction_id text   PRIMARY KEY,
    order_id       text   NOT NULL,
    partner_id     text   NOT NULL,
    status         text   NOT NULL,
    version        bigint NOT NULL
);
CREATE INDEX partner_bills_order ON services.partner_bills (order_id);

-- +goose Down
DROP TABLE services.partner_bills;
