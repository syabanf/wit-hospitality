-- +goose Up
-- Events written in the same transaction as the change they describe; the relay publishes them.
CREATE TABLE platform.outbox (
    id                bigserial PRIMARY KEY,
    event_id          uuid        NOT NULL UNIQUE,
    event_type        text        NOT NULL,
    aggregate_type    text        NOT NULL,
    aggregate_id      text        NOT NULL,
    aggregate_version bigint      NOT NULL DEFAULT 0,
    payload           jsonb       NOT NULL,
    metadata          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    occurred_at       timestamptz NOT NULL,
    published_at      timestamptz,
    attempts          integer     NOT NULL DEFAULT 0,
    last_error        text
);
CREATE INDEX outbox_pending ON platform.outbox (id) WHERE published_at IS NULL;

-- The inbox: one row per consumer and event, so a redelivered event is applied once.
CREATE TABLE platform.processed_events (
    consumer     text        NOT NULL,
    event_id     uuid        NOT NULL,
    event_type   text        NOT NULL,
    processed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer, event_id)
);

-- Replays a write that a client retried with the same Idempotency-Key header.
CREATE TABLE platform.idempotency_keys (
    user_id      text        NOT NULL,
    key          text        NOT NULL,
    method       text        NOT NULL,
    path         text        NOT NULL,
    request_hash text        NOT NULL,
    status       integer     NOT NULL,
    response     bytea       NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
);

-- Every mutation, with values before and after, written in the mutation's transaction.
CREATE TABLE platform.audit_log (
    id          text        PRIMARY KEY,
    at          text        NOT NULL,
    user_id     text        NOT NULL,
    user_name   text        NOT NULL,
    role        text        NOT NULL,
    action      text        NOT NULL,
    entity      text        NOT NULL,
    entity_id   text        NOT NULL,
    summary     text        NOT NULL,
    before      jsonb,
    after       jsonb,
    recorded_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE platform.audit_log;
DROP TABLE platform.idempotency_keys;
DROP TABLE platform.processed_events;
DROP TABLE platform.outbox;
