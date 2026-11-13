| the reservation service, for a property or services service that asks about stays (`/internal/v1/stays`) |# Bali Villa Console API: architecture

The Go service in `api/` implements the `/api/v1` contract that `src/infrastructure/http/index.ts`
calls, with the rules and error codes the TypeScript mock adapter (`src/infrastructure/mock`)
enforces today. Point the console at it with `VITE_API_URL=http://localhost:8080/api/v1`.

Phase 0 builds the foundation, the **identity and access** context and the **property** context.
Phase 1 adds the **channel** context (Airbnb accounts and listings, the public site, web enquiries),
the **guest** context and the **reservation** context (bookings, groups, stay rules, walks, online
check-in).
Phase 2 adds the **billing** context (folio, guest payments and links, cashier shifts, night audit,
city ledger, tax settings and transaction codes). It also adds the **owners** context (villa owners, management contracts, owner
statements, owner stays) and the **files** context (uploads).
Phase 3 starts with the **services** context (room service menu, orders, guest QR ordering, service
requests).
Phase 3 also adds the **housekeeping** context, and phase 4 the **messaging** context (guest
messages and the e-invoice link).
Later phases add one context at a time on the same foundation; the ownership table at the end says
which context owns each of the 305 adapter calls.

## Layout

```
api/
  cmd/
    monolith/        every context in one process, in-process bus
    identity/        identity alone (split mode, NATS)
    property/        property alone (split mode, NATS)
    channel/         channel alone (split mode, NATS)
    guest/           guest alone (split mode, NATS)
    housekeeping/    housekeeping alone (split mode, NATS)
    messaging/       messaging alone (split mode, NATS)
    reservation/     reservation alone (split mode, NATS)
    billing/         billing alone (split mode, NATS)
    owners/          owners alone (split mode, NATS)
    files/           files alone (split mode)
    services/        services alone (split mode, NATS)
    migrate/         applies the embedded migrations
    seed/            loads the demo data (DEMO_MODE=true only)
    outbox-relay/    publishes the outbox to NATS in split mode
  internal/
    platform/        shared kernel, imports no context
      config/        environment, fail fast with every problem listed
      logging/       slog JSON, request id and user id per record, secrets masked
      httpx/         router, { data } and { error } envelopes, status mapping, CORS, decode, idempotency
      auth/          JWT access token, rotating refresh token, cookies, middleware, argon2id
      rbac/          permission matrix ported from access.ts, Can, scope, Authorizer, sources
      db/            pgx v5 pool, transaction carried on the context
      migrations/    goose runner and the platform schema
      outbox/        append in the writing transaction, relay
      bus/           Bus interface, in-process and NATS JetStream implementations
      projector/     event handlers with the inbox, read-your-writes middleware
      clock/ ids/ audit/ errs/ testdb/
    identity/        events.go (published language)
      domain/ app/command/ app/query/ adapters/postgres/ ports/http/ module/
    property/        events.go (published language)
      domain/ app/command/ app/query/ adapters/postgres/ adapters/stays/ ports/http/ module/
    channel/         events.go, prices.go (published language: events and the price lookup)
      domain/ app/command/ app/query/ adapters/postgres/ adapters/sources/ adapters/client/
      ports/http/ module/
    maintenance/     work orders, expenses, assets, vendors, preventive plans; adapters/client/ (property holds)
    inventory/       items, villa stores, movements, receipts, counts, kits, minibar
    bootstrap/       composition root: builds contexts, picks clients and bus, router, seed
  deploy/gateway/    Caddyfile for split mode
  docs/              this file
  scripts/           node scripts: fixtures export, rbac snapshot, contract coverage, wiring check
  seed/              one fixture per context (exported from the TS seed builders)
  openapi.yaml       served at /api/v1/docs/openapi.yaml
```

## Boundaries

1. A context lives under `internal/<context>/`. Its root package holds only its published language:
   `events.go` (event names and payloads) and, where other contexts read from it, the result types
   and interface of that lookup (channel's `prices.go`). That root package is the only part another
   context may import.
2. Contexts never import each other's subpackages and never join across schemas. Each context owns
   one Postgres schema (`identity`, `property`, `channel`); the shared `platform` schema holds the outbox, the
   inbox (`processed_events`), idempotency keys and the audit log.
3. A cross-context read goes through a small interface the consumer defines (property's
   `command.Stays`, everyone's `rbac.Source`, the middleware's `auth.Refresher`). The composition
   root supplies an in-process implementation in the monolith and an HTTP one in split mode.
4. A cross-context reaction goes through an event on the bus, never a direct call.
5. `internal/platform` imports no context. Domain packages import nothing from adapters, ports or app.

`architecture_test.go` enforces rules 1, 2 (imports and SQL schema names) and 5 on every `go test`.

## Inside a context (CQRS)

| Layer | Package | Does |
| --- | --- | --- |
| Domain | `domain/` | Aggregates, value objects, validators and rules. Pure. Errors carry the TS `RuleError` codes and wording. |
| Commands | `app/command/` | One handler per command: check permission and villa scope, load (row locked), apply rules, save with an optimistic version check, append events and the audit line, all in `db.InTx`. |
| Queries | `app/query/` | Read handlers over read-model tables or views of the context's own schema, filtered to the caller's scope. No domain logic. |
| Adapters | `adapters/postgres/` | Write repository, read store, projections, seed loader, embedded migrations. |
| Ports | `ports/http/` | chi routes on the exact contract paths and payload shapes the TS adapter uses. |
| Wiring | `module/` | Builds the context from `Deps`; exposes `Routes`, `Project`, migrations. |

Read models come in two kinds, both inside the context's schema:

- **Views** over write tables (`identity.v_users`, `identity.v_permissions`): consistent at once.
- **Projected tables** kept by the projector (`property.rm_*`, `identity.audit_trail`): each row
  carries the villa and location it sits in, so scope filters need no join, and a `version`
  column drops an older event that arrives late. Property serves every read from `rm_*` tables.

## Events, outbox, bus and projector

```
command tx ──> write tables + platform.outbox row (+ pg_notify) ──commit──┐
                                                                            v
relay (LISTEN platform_outbox, poll every 1 s) ── publish in id order ──> bus
                                                                            │
          in-process bus (monolith): handlers run inside Publish            │
          NATS JetStream (split): stream EVENTS, subject events.<type>,     │
                                  durable pull consumer per consumer name   v
projector: per (consumer, event) one transaction: INSERT processed_events ON CONFLICT DO NOTHING,
           then the handler; a duplicate is skipped, so delivery is at-least-once and effects once.
```

- Event names are versioned: `property.unit.created.v1`. A breaking payload change is a new name.
- Payloads carry the full state of the record plus its villa and location ids.
- The relay stops at the first failed publish to keep order and retries on the next pass.
- **Read your writes**: `projector.ReadYourWrites` holds a successful write's response until every
  local consumer of the events it appended has processed them (at most 3 s). The console reloads a
  list right after a save, so this keeps the page consistent in both modes. A handler's events carry
  the causing request id in their metadata, and the wait follows them (`Projector.AwaitChain`): a
  listing price edit answers once property has moved the unit and projected `unit.updated`.
- Audit lines are events too (`platform.audit.recorded.v1`); identity projects them into
  `identity.audit_trail`, so every context feeds the one trail `GET /audit` serves, even on
  separate databases.

### Catching up a late copy

A migration that adds a table fed only by another context's events leaves it empty on a database
whose events already went by. `internal/platform/snapshot` closes that gap without a reseed:

- The source context answers the current state of its records as the payloads its events carry
  (`snapshot.Sources`, one function per event type, in `adapters/postgres/snapshots.go`). The
  composition root merges the sources of the contexts a process runs and serves them on
  `GET /internal/v1/snapshots/{eventType}` behind `INTERNAL_TOKEN`.
- The consumer replays those records through its own registered handler (`Projector.Replay`), in
  one transaction and without inbox rows. Only that consumer sees them, so no other context's
  reaction fires, as it would if the source republished its events.
- `bootstrap.catchUps` lists the copies: owners' `rm_groups` (from reservation's
  `booking_group.saved`), billing's `cat_groups` and `cat_units.group_id` (property's
  `unit_group.updated`, `unit.updated`), `cat_accounts` (channel's `airbnb_account.updated`),
  `rm_requests` (services' `request.saved`), reservation's unit capacity on `cat_units` (property's
  `unit.updated`), reservation's and housekeeping's villa operation on `cat_villas` and room type
  kind on `cat_unit_groups` (property's `villa.updated`, `unit_group.updated`), reservation's late
  check-out fee on `cat_villas` (property's `villa.updated`), housekeeping's service window on `stays`
  (reservation's `booking.saved`) and channel's public `site` profile on `rm_villas` and `rm_units`
  (property's `villa.updated`, `unit.updated`). `App.Fill` runs them on every start, in process when
  the source runs here, else over HTTP to `RESERVATION_URL`, `PROPERTY_URL`, `CHANNEL_URL` or
  `SERVICES_URL`, retrying every 5 s until the source answers.
- Handlers are versioned upserts (rule 6), so a second run, a second replica or an event arriving
  meanwhile keeps the newer row.

## Sessions and auth

- Login checks the argon2id hash and opens a session: a 15-minute HS256 JWT access token and an
  opaque refresh token (only its SHA-256 is stored), both in httpOnly SameSite=Lax cookies on
  `/api/v1` (`wit_access`, `wit_refresh`). The console's client sends `credentials: 'include'` and
  no Authorization header; a Bearer header also works for scripts.
- The middleware renews an expired access token from the refresh cookie on any request and sets new
  cookies, so the console never sees the expiry and needs no refresh call. `POST /auth/refresh` is
  there for clients that want to renew ahead of time.
- Refresh tokens rotate on every use. A request that presents a token a sibling request rotated in
  the last 30 seconds gets an access token only (the page fires parallel calls with one cookie). An
  old token after that window revokes the whole session as a theft.
- Deactivating a user or changing a password revokes sessions. Access tokens are stateless: role and
  scope in a token can be up to 15 minutes old.
- `DEMO_MODE` gates `cmd/seed` (every demo login shares `villa123`) and is refused in production. The
  console's quick login (`?as=wayan`) posts the normal `auth/login` with the demo password, so it
  needs no extra endpoint.
- New logins start with `INITIAL_USER_PASSWORD` (default `welcome123`, as the mock does).

## Permissions and scope

`rbac.DefaultPermissions()` is `DEFAULT_PERMISSIONS` ported as data. `scripts/export-permissions.mjs`
writes the TypeScript matrix to `internal/platform/rbac/testdata/default_permissions.json`, and
`TestMatrixMatchesTypeScriptSnapshot` fails if the two differ. Identity stores edits per role in
`identity.role_permissions`; a role without a row reads the default.

Commands call `rbac.Authorizer.Require(role, needs...)`, which passes when the role holds any of the
needs and refuses with `FORBIDDEN` and the console's wording (`Staff cannot create in Master data.`).
Writes to a villa outside the caller's `villaIds`/`locationIds` are refused with `FORBIDDEN`. Reads
return only what the scope allows, as the console's `catalog()` does.

| Endpoint | Needs |
| --- | --- |
| `GET /users`, `GET /audit` | access/view |
| `POST /users` | access/create |
| `PATCH /users/{id}`, `PUT /permissions/{role}` | access/edit (`ACCESS_SELF`, `ACCESS_OWNER` rules) |
| `GET /permissions`, `/auth/session`, `/me` | signed in |
| `POST /locations, /villas, /properties, /unit-groups, /units` | master/create |
| `PATCH /locations/{id}, /villas/{id}` | master/edit |
| `PATCH /unit-groups/{id}, /units/{id}` | master/edit or property/edit |
| `PUT /unit-groups/{id}/rate-plan` | property/edit |
| `POST /unit-blocks` | booking/create or property/edit |
| `DELETE /unit-blocks/{id}` | booking/edit or property/edit |
| property reads | signed in, scoped |
| `GET /airbnb-accounts` | signed in (bookings name their source) |
| `GET /airbnb-listings` | signed in, scoped by the listing's unit |
| `POST /airbnb-accounts, /airbnb-listings` | airbnb/create |
| `PATCH /airbnb-accounts/{id}, /airbnb-listings/{id}`, `PUT /airbnb-listings/{id}/prices` | airbnb/edit, listing writes scoped by unit |
| `GET /enquiries` | booking/view (`Staff cannot view web enquiries.`), owner notes plus enquiries in scope |
| `POST /enquiries/{id}/status, /enquiries/{id}/convert` | booking/edit, scoped by the enquiry's villa |
| `GET /public/site/inventory, /public/site/holds`, `POST /public/enquiries` | no session; the audit names `Guest` |

The TypeScript adapter checks only the listing price edit (`allow('airbnb', 'edit')`); the API checks
every Airbnb write with the module's create or edit action, which the Airbnb pages already gate on.

## Errors

Every refusal is `errs.Error{Code, Message, Fields}`. `httpx.WriteError` answers
`{ "error": { "code", "message", "fields"? } }`; the first field error is the message, as the mock's
`refuse` does.

| Code | Status |
| --- | --- |
| `VALIDATION_ERROR` | 422 |
| `UNAUTHENTICATED`, `INVALID_CREDENTIALS` | 401 |
| `FORBIDDEN`, `USER_INACTIVE`, `ACCESS_OWNER`, any `*_FORBIDDEN` | 403 |
| `NOT_FOUND` | 404 |
| any other business rule (`ACCESS_SELF`, `UNIT_IN_USE`, `ROOMS_TO_ASSIGN`, `BLOCK_OVERLAP`, `ENQUIRY_INVALID_STATE`, `SITE_VILLA_CLOSED`, `CONCURRENT_UPDATE`, ...) | 409 |
| `INTERNAL` (details logged, never sent) | 500 |

## Platform details

- **IDs** follow the console: `usr-`, `loc-`, `vil-`, `grp-`, `blk-`, `aud-` plus a slug and a random
  tail; units keep `unit-<code>` as the mock does. Seed ids are kept as exported.
- **Clock**: handlers read an injectable clock in `BUSINESS_TZ` (default Asia/Makassar). Dates are
  `YYYY-MM-DD`; audit `at` is local `YYYY-MM-DDTHH:MM:SS`, the mock's format.
- **Audit**: `audit.Recorder.Record` writes `platform.audit_log` and the event in the command's
  transaction, with before and after values where the mock keeps them.
- **Idempotency**: a write carrying `Idempotency-Key` is stored per user and replayed on retry;
  reusing a key for a different body is `IDEMPOTENCY_CONFLICT`. The console's HTTP adapter
  (`src/infrastructure/http/client.ts`) sends a fresh key with every write and sends the same key
  again when it retries that write after a network failure or a 502/504. Uploads and `auth/` calls
  go without one: the middleware buffers keyed bodies only up to 1 MiB, and a replay carries no
  cookies.
- **Logging**: JSON on stdout, one access line per request with `request_id` and `user_id`; keys
  containing password, secret, token, authorization, cookie or hash are masked.
- **Health**: `GET /api/v1/health` answers `{ ok, version, service, db, bus, contexts }`, 503 when the
  database or bus is down.

## Database and migrations

Each context embeds its goose migrations (`adapters/postgres/migrations`) and keeps its version table
in its own schema (`identity.goose_db_version`), so the context moves to its own database with its
history. `cmd/migrate` runs platform, then each context. The monolith runs them on start with
`MIGRATE_ON_START=true`; split mode runs the one-shot `migrate` service first.

## Monolith and split mode

| | Monolith | Split |
| --- | --- | --- |
| Processes | `cmd/monolith` | `cmd/identity`, `cmd/property`, `cmd/channel`, `cmd/guest`, `cmd/reservation`, `cmd/billing`, `cmd/services`, `cmd/people`, `cmd/payroll`, `cmd/maintenance`, `cmd/inventory`, `cmd/owners`, `cmd/files`, `cmd/housekeeping`, `cmd/messaging`, `cmd/finance`, `cmd/outbox-relay`, Caddy gateway |
| Unit holds for work orders | property in process, inside the work order's transaction | `PROPERTY_URL` `/internal/v1/unit-blocks/holds` and `/{id}/release` |
| Work orders from housekeeping | maintenance in process, inside housekeeping's transaction | `MAINTENANCE_URL` `/internal/v1/work-orders/reports` |
| Stock items for housekeeping | inventory in process | `INVENTORY_URL` `GET /internal/v1/stock/items` |
| Catching up copies a later migration added (below) | the source context in process | `GET /internal/v1/snapshots/{eventType}` on the source's URL |
| Bus | in-process (`BUS=inproc`) | NATS JetStream (`BUS=nats`) |
| Relay | embedded (`OUTBOX_RELAY=embedded`) | `cmd/outbox-relay`; services set `OUTBOX_RELAY=off` |
| Session renewal and matrix in property | identity in process | `auth.HTTPRefresher` and `rbac.HTTPSource` (10 s cache) to identity's `/internal/v1`, guarded by `INTERNAL_TOKEN` |
| Entry | `:8080/api/v1` | gateway `:8090/api/v1`, routes by prefix (`deploy/gateway/Caddyfile`) |

Both modes share one Postgres instance today; each service touches only its schema and `platform`.

Every cross-context client has a real answer in both modes: the monolith passes the other
module, and `docker-compose.yml` gives each split service the `*_URL` of every context it calls.
The stand-ins (`PendingBilling` in reservation, services and messaging, billing's
`PendingFinance`, `NOT_AVAILABLE` from a client func that returns nil) remain only for a process
that runs a context without its dependency: the route list (`make contract`), a handler test that
builds one module, or a split service started without that URL.

Environment (all read by `internal/platform/config`, which lists every problem at once):

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | required | |
| `JWT_SECRET` | required for HTTP services | at least 32 characters |
| `HTTP_ADDR` | `:8080` | |
| `BUS` | `inproc` | `nats` for split services |
| `NATS_URL` | `nats://localhost:4222` | |
| `OUTBOX_RELAY` | `embedded` | `off` when `cmd/outbox-relay` runs |
| `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL` | `15m`, `720h` | |
| `COOKIE_SECURE` | `false` | must be true in production |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | credentials allowed |
| `DEMO_MODE` | `false` | must be true for `cmd/seed`; refused in production |
| `BUSINESS_TZ` | `Asia/Makassar` | |
| `IDENTITY_URL`, `INTERNAL_TOKEN` | | required by services that do not run identity |
| `CHANNEL_URL` | | channel's base URL for services that read listing prices without running channel, and for a billing service that catches up its Airbnb accounts (`/internal/v1/snapshots/{eventType}`) |
| `GUEST_URL` | | the guest service, for split services that call the guest client |
| `MESSAGING_PROVIDER` | `simulated` | `live` sends WhatsApp through Fonnte and email over SMTP |
| `FONNTE_TOKEN` | | the Fonnte device token, for `MESSAGING_PROVIDER=live` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | port `587` | the mail server, for `MESSAGING_PROVIDER=live` |
| `RESERVATION_URL` | | the reservation service, for a property service that asks about stays (`/internal/v1/stays`), a billing service that closes a paid check-out, a channel service that reads the site's stays (`/internal/v1/site`) and an owners service that catches up its booking group copy (`/internal/v1/snapshots/{eventType}`) |
| `BILLING_URL` | | the billing service, for reservation and services services that ask about money, a messaging service that renders the e-invoice and a housekeeping service that plans the business date on start (`/internal/v1/billing`) |
| `PEOPLE_URL` | | the people service, for a billing service that checks a cashier's roster before a shift opens (`/internal/v1/people/rostered`) |
| `FILES_STORAGE` | `local` | `local` keeps uploads under `FILES_DIR` (default the temp dir's `wit-files`); `s3` puts them in a bucket |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | region `us-east-1` | for `FILES_STORAGE=s3`: any S3-compatible service, path-style |
| `FILES_PUBLIC_URL` | `http://localhost:8080/api/v1` | the base an attachment's `url` points at (`.../files/{id}`) |
| `FINANCE_URL` | | the finance service, for split services that call the finance client (billing, payroll, owners) |
| `FILES_URL` | | the files service, for a finance service that resolves receipts by id (`/internal/v1/files`) and a property service that checks photo uploads and streams the public site's photos (`/internal/v1/files`, `/internal/v1/files/{id}/content`) |
| `SERVICES_URL` | | the services service, for a channel service that prints the room service menu on the public site (`/internal/v1/site-menu`) and a billing service that catches up its service requests (`/internal/v1/snapshots/{eventType}`) |
| `PROPERTY_URL` | | required by a maintenance service that does not run property; billing, reservation and channel services catch up their copies of villas, room types and units from it (`/internal/v1/snapshots/{eventType}`) |
| `MAINTENANCE_URL` | | the maintenance service, for a housekeeping service that opens work orders (`/internal/v1/work-orders/reports`); without it opening one answers `NOT_AVAILABLE` |
| `INVENTORY_URL` | | the inventory service, for a housekeeping service that names stock items and keeps linen pars to linen (`/internal/v1/stock/items`); without it the item id stands in and the kind check passes |
| `MIGRATE_ON_START` | `false` | |
| `INITIAL_USER_PASSWORD` | `welcome123` | |
| `APP_ENV`, `APP_VERSION`, `LOG_LEVEL` | `development`, `dev`, `info` | |

## Seed data

`scripts/export-seed.mjs` loads `src/infrastructure/mock/state.ts` through Vite's SSR loader (the
repo has no tsx; Vite resolves the `@/` alias exactly as the app does), calls `buildState(baseDate)`
and writes the identity, property, channel, guest, reservation, billing, services, housekeeping and messaging slices to `seed/*.json` with that
base date. Reservation loads after property's events are projected, since it reads villas from its
catalog copy; one-off restriction dates shift, yearly ones do not. Listing date prices move by the shift rounded to whole
weeks, so the seed's Friday and Saturday prices stay on those nights. `cmd/seed` embeds both files, shifts every date by today minus the base date, inserts
the write model, appends a created event per record and drains the outbox through the in-process
projector, so read models are built by the same code that serves commands. Rerun
`make export-fixtures` after the TypeScript seed changes. Owners loads the villa owners, contracts,
owner stay requests and the September and October statements (both approved, September's payout
posted, October's waiting) with each payout's transaction id, number and status; statement months move
by whole months to stay the last two complete months, and their figures keep the TypeScript amounts.

`seed/maintenance.json` (work orders, assets, vendors, plans) and `seed/inventory.json` (items,
movements, receipts, counts, kits, minibar links, the minibar menu items) come from the same
`buildState` call. Each also carries the mock's `next` counters, so new records continue the mock's
numbering (`WO-519`, `SR-310`, `SM-2185`), and the status of every cash-out a seeded expense line or
purchase points at, since finance does not hold them yet. Item average costs are replayed from the
seeded movements, never read from the file.

## Running

```
cd api
make db                 # Postgres 16 on :55432 and NATS on :4222
make seed               # migrate and load the demo data
make run                # monolith from source on :8080 (API_PORT=8088 make run to move it)
make up                 # or: Postgres, NATS and the monolith in Docker
make split-up           # identity, property, channel, relay and the gateway on :8090
make test               # unit, integration (needs make db; skips without it), HTTP, rbac snapshot
make lint               # go vet and staticcheck
make contract           # implemented vs missing calls per context; fails if a done context misses one
make wiring             # the TS HTTP adapter against the running API, compared with the mock
make down
```

Console against the API: `VITE_API_URL=http://localhost:8080/api/v1 pnpm dev` from the repo root.

## Tests

- Domain: property rules ported case by case from `ratePlan.test.ts` and `property.test.ts`, the
  wizard, blocks; identity rules, password change, refresh decisions.
- rbac: the Go matrix against the TypeScript snapshot, `Can`, `PortalOnly`, scope.
- Command and query handlers against a real Postgres: `testdb.New` creates a fresh database per
  test with every migration applied (contexts own fixed schema names, so a database is the unit of
  isolation) and skips with a message when Postgres is unreachable.
- HTTP (`internal/bootstrap`): login and logout, silent refresh after expiry, forbidden calls, scoped
  lists, a property command whose event is published from the outbox and whose read model and audit
  line are visible on the next request, health and docs.
- `architecture_test.go`: the boundaries above.
- Channel: listing, account, price and enquiry rules ported from `airbnb.ts`, `pricing.test.ts`,
  `enquiry.ts`, `services.test.ts` and `site.test.ts`; handlers on a fresh database (scope, refusals,
  the priced event, the price lookup); HTTP tests for a price edit that moves the unit, a forbidden
  edit, the public site and the internal price routes.
- Billing: the folio, tax, payment, audit, shift and city ledger rules ported from `folio.test.ts`,
  `tax.test.ts` and the application tests; handlers on one fresh seeded database (tax dates, codes,
  charges, settle, payments, shifts, city ledger, the audit, voids); HTTP tests for a charge with
  tax lines, a rebate and refund, settle and check out, the audit and its rerun, a gateway link and a
  city ledger transfer, each checking the event it publishes.
- Services: menu, order and request rules ported from `serviceOrder.test.ts` and
  `roomService.test.ts` (totals, splits, pay states, hours and notice, orderable stays, late flags,
  QR tokens pinned to the console's values); handlers on a fresh database (scope, ORDER_NO_STAY,
  ITEM_UNAVAILABLE, ITEM_LEAD_TIME, COMP_FORBIDDEN, DISCOUNT_LIMIT, the board, the void guard, the
  events); HTTP tests for a desk order, a refused lead time, a guest QR order through the public
  token, a delivered order whose event the relay publishes, and reservation's internal stay route.
- `scripts/wiring-check.mjs`: the console's own HTTP adapter against a running API, property and
  channel reads equal to the mock adapter's, access reads equal in shape and ids. Maintenance and
  stock reads equal the mock's ignoring key order; a work order with a block and a submitted expense,
  `STOCK_SHORT`, a receipt, a refused correction and a count run on both and must agree.
- Maintenance and inventory: `stock.test.ts` ported case by case (the replay drift when an earlier
  receipt is cancelled, the corrected receipt average, day pricing, transfers), the maintenance
  rules, handler tests for corrections and cancellations after a rejection arrives from finance's
  event, block holds and releases through property, and HTTP tests for a work order with an
  expense, a `STOCK_SHORT` refusal, a receipt correction and a count.
- Owners: the TypeScript seed's six statements replayed through the Go draft give the same figures and
  settlements; carry forward, top-up journal, close order, reopen, approval roles, the owner night
  allowance; handlers on a fresh database (portal scope, close, approve, pay, finance's answers, owner
  stays); HTTP tests for close, approve and pay with their events, an investor refused on every
  booking read, an approved owner stay blocking the unit, and a file upload.

## Channel

Channel owns the Airbnb host accounts, one listing per unit with its status (live or paused) and its
per-night prices, the web enquiries, and the public site's reads. Its schema holds the write tables
(`airbnb_accounts`, `listings`, `enquiries`), the `v_listings` view, and `rm_*` tables projected from
property's events: the site's catalog, and the villa and location that scope listings and enquiries.

**The base price has one owner: property.** The TypeScript price list puts the base rate on the unit
(`unit.nightlyRate`) and the per-night prices on the listing; the unit form edits the rate, and units
without a listing (KR-03, PD-01) still need it for rate plans. So property owns the rate and channel
owns the date prices. `PUT /airbnb-listings/{id}/prices` saves the date prices, records the audit
line and appends `channel.listing.priced.v1` with the new base rate; property's policy
(`command.FollowListingBaseRate`, consumer `property.listing-base-rate`) moves the unit to it and
publishes `property.unit.updated.v1`, which channel projects back into `rm_units`. A direct unit edit
reaches the listing the same way. Neither context writes the other's tables, and the chained
read-your-writes wait keeps the listing page consistent after a save.

**Price lookup for reservation.** `channel.Prices` (in `internal/channel/prices.go`):

- `ActiveListing(ctx, unitID) (*UnitListing, error)`: the live listing with its base rate and date
  prices, nil when the listing is paused or absent (the rate plan prices the stay then).
- `NightlyPrices(ctx, unitID, from, to) ([]NightPrice, bool, error)`: each night in `[from, to)` at its
  date price or the base rate, with `custom` marking a date price; false without a live listing.

The monolith passes the module's in-process answer; a service without channel gets
`adapters/client.HTTP`, which calls `GET /internal/v1/channel/listings/active?unitId=` and
`GET /internal/v1/channel/prices?unitId=&from=&to=` with `INTERNAL_TOKEN`. `bootstrap.Build` puts
the right one on `App.ChannelPrices` (`CHANNEL_URL` selects the HTTP client).

**What channel reads from contexts that do not exist yet.** `adapters/sources.None` answers for
records other contexts own: the booking an enquiry converts to (`command.Bookings`, reservation), and
the site's stays, stay rules, menu, team and tax (`query.SiteSources`: reservation, services, people,
finance). It reports none of them and the default tax settings, which is true for an API holding no
such records. Each owner's phase replaces one answer with a client. Reservation's answers (the
booking code, held nights and stay restrictions) come from `reservation.Site` in process, or from
`sources.Reservation` over `RESERVATION_URL` (`/internal/v1/site/bookings/{id}`, `/site/holds`,
`/site/restrictions`) in split mode.

## Maintenance and inventory (phase 3)

Both contexts follow the property slice: `events.go`, `domain/`, `app/command/`, `app/query/`,
`adapters/postgres/`, `ports/http/`, `module/`, one schema each (`maintenance`, `inventory`). The
rules come from `src/domain/maintenance.ts`, `src/domain/stock.ts`, the mock adapter
(`src/infrastructure/mock/index.ts` maintenance port, `src/infrastructure/mock/stock.ts`) and the
`allow()` calls in `src/application/services.ts` and `src/application/stock.ts`, with the same codes
and wording (`WORK_ORDER_INVALID_STATE`, `TRANSACTION_INVALID_STATE`, `STOCK_SHORT`,
`ORDER_NO_STAY`, `ITEM_UNAVAILABLE`, `BLOCK_OVERLAP`).

Storage. Work orders, assets, vendors, plans, receipts and counts are JSON documents in a row with
the columns commands look up by and a version for optimistic concurrency. Movements and items are
plain columns. Reads come from views (`v_work_orders`, `v_movements`, ...) that join the projected
villa for the location scope filter.

Average cost. An item's average is never typed in: every stock write takes a transaction-level
advisory lock (the average is one per item across every store), loads the movements, runs
`domain.ReplayCost` (a port of `replayCost`, `liveMovements` and the replay order), stores each
item's current average and answers `GET stock/items` from it. `STOCK_SHORT` on a receipt correction
or cancellation comes from `domain.FirstShortfall` over the movements with the receipt replaced, and
names the day the store would go below zero.

| Endpoint | Needs |
| --- | --- |
| `POST work-orders`, `assets`, `vendors`, `preventive-plans`, `preventive-plans/generate` | maintenance/create |
| `PATCH work-orders/{id}`, `assets/{id}`, `vendors/{id}`, `preventive-plans/{id}`; `POST work-orders/{id}/notes`, `/status`; `PUT work-orders/{id}/block` | maintenance/edit (`/status` to `verified` needs maintenance/approve) |
| `POST work-orders/{id}/expenses`, `PUT work-orders/{id}/expenses/{expenseId}` | maintenance/submit |
| `POST stock/items` | maintenance/create |
| `PATCH stock/items/{id}`, `POST stock/movements`, `POST stock/counts`, `PUT stock/kits/{groupId}`, `PUT stock/minibar-links/{menuItemId}` | maintenance/edit |
| `POST stock/receipts`, `PUT stock/receipts/{id}`, `POST stock/receipts/{id}/cancel` | maintenance/submit; correcting or cancelling also needs to be the purchase's author or hold maintenance/approve |
| `POST bookings/{id}/minibar-checks` | services/create |
| reads | signed in, scoped to the villa (vendors and stock items are shared by every villa) |

### Cross-context clients

| Need | Owner | How (decision) |
| --- | --- | --- |
| Villas, units, room types | property | projected from `property.villa.*`, `property.unit.*`, `property.unit_group.*` into `ref_*` tables (rule 5) |
| Unit block while a job is open | property | `command.Blocks` client (rule 3): the monolith calls property's `HoldBlock`/`ReleaseBlock` in process, inside the work order's transaction; split mode calls property's `/internal/v1/unit-blocks/holds` and `/{id}/release`. Releasing deletes a block that has not started and cuts one under way to end today; property publishes `property.unit_block.trimmed.v1` for the cut |
| Expense and purchase cash-outs, their approval | finance (not built) | `command.CashOutRequests` (`Submit`, `Correct`, `Cancel`, `Status`), below |
| Bookings for a minibar check | reservation | `command.Stays` over `ref_stays`, projected from `reservation.booking.saved.v1` and `.status_changed.v1` (rule 5) |
| Minibar menu items | services | `ref_menu_items`, projected from `services.menu_item.saved.v1` (and seeded from the mock menu, so the handler tests need no services schema) |
| Minibar sales | services | reacts to `services.order.delivered.v1` and `services.order.voided.v1` (`services.OrderBilled`) |

### The finance gap

Finance owns cash-outs and their approval chain. Until it runs, each context's in-process
`CashOutRequests` (`adapters/postgres/cashouts.go`) records a request as a row in its own
`cash_outs` table with status `submitted` and appends the request with its full amount to the
outbox: `maintenance.expense.submitted.v1` and `inventory.purchase.submitted.v1`, then
`*.resubmitted.v1` after a correction and `inventory.purchase.cancelled.v1` when a rejected purchase
is given up. Ids and numbers are provisional (`tx-m12`/`TX-M2412`, `tx-s12`/`TX-S2412`); finance
adopts them when it consumes the request. Finance answers with `finance.cash_out.decided.v1`
(`{ transactionId, number, status, rejectionReason, version }`), which both contexts apply to their
local status; corrections and cancellations need that status to be `rejected`. Until finance runs:

- nothing approves or rejects: the status stays `submitted`, so corrections and cancellations are
  refused (`TRANSACTION_INVALID_STATE`), as they are in the mock for a submitted cash-out;
- the proof rule (`PROOF_REQUIRED` above the threshold) and the choice of account (location cashbox
  for cash, the bank for a transfer) belong to finance and are not applied here;
- vendor spend and asset cost to date, which the console computes from posted cash-outs, read the
  finance transactions the console fetches, so they show nothing new until finance serves them.

Finance now consumes these requests and answers with `finance.cash_out.decided.v1`; see "Finance
context" for the id and numbering it applies.

### Minibar and the services context

- `POST bookings/{id}/minibar-checks` answers with the delivered order in the console's shape
  (`so-mb-N`, `SO-MN`), keeps it in `minibar_checks` and publishes
  `inventory.minibar_check.recorded.v1` for services to adopt and bill. Services does not consume it
  yet, so a minibar check reaches neither the order board nor the folio until it does; when it does,
  it must not publish `services.order.delivered.v1` for it, because the restock already left the store.
- `services.order.delivered.v1` books the minibar lines out of the villa store in full, in the name
  "Room service" on the delivery day (the event names no person): the order
  already reached the guest, so a short store goes below zero instead of refusing, and the next count
  puts it right. `services.order.voided.v1` puts the sold stock back at the cost it left at.
- Housekeeping (later) issues amenity kits and writes off linen through inventory; it will need a
  client with `IssueKit` and `WriteOff` over the same `Book` code.

### Events

Published: `maintenance.work_order.saved.v1` (state after every change), `maintenance.expense.*`,
`inventory.purchase.*`, `inventory.stock.moved.v1` (the movements one command booked),
`inventory.stock.low.v1` (a movement brought a store down to an item's reorder level),
`inventory.minibar_check.recorded.v1`. Consumed payloads are defined in each context's `events.go`.

## Contract ownership

Generated by `node scripts/contract.mjs --markdown` from `scripts/ownership.mjs`. "Calls" counts the
`http.*` call sites in `index.ts`; "Endpoints" counts distinct method and path pairs after expanding
action maps (`bookings/{id}/confirm`, `.../cancel`, ...). Each later phase implements one row and
adds its prefixes to the gateway.

| Context | Phase | Calls | Endpoints | Owns |
| --- | --- | --- | --- | --- |
| identity | 0 | 13 | 12 | Sessions, users, roles and the permission matrix, villa and location scope, profile, audit trail |
| property | 0 | 18 | 18 | Locations, villas, room types, units, unit blocks, facilities, rate plans, the New property wizard |
| channel | 1 | 14 | 13 | Airbnb accounts and listings, the public site inventory and holds, web enquiries |
| reservation | 1 | 31 | 32 | Bookings and their lifecycle, groups, stay restrictions, overbooking and walks, pre-check-in |
| guest | 1 | 18 | 18 | Guest profiles, blacklist and merge, companions, foreign guest reports, lost and found |
| billing | 2 | 47 | 47 | Folio, guest payments and links, cashier shifts, city ledger, night audit, tax settings, transaction codes |
| finance | 2 | 35 | 40 | Cash accounts, categories, transactions and approvals, reconciliation, general ledger, tax, budgets |
| owners | 2 | 16 | 16 | Villa owners, management contracts, owner statements, owner stays |
| services | 3 | 19 | 23 | Service requests, room service menu, partners and orders, guest ordering |
| maintenance | 3 | 18 | 18 | Work orders, assets, vendors, preventive plans |
| housekeeping | 3 | 20 | 20 | Room states and inspections, daily tasks, linen and laundry |
| inventory | 3 | 16 | 16 | Stock items, receipts, movements, counts, amenity kits, minibar |
| people | 4 | 24 | 30 | Employees, shifts and rosters, attendance, leave, overtime, loans, announcements, KPI reviews |
| payroll | 4 | 9 | 11 | Payroll settings and periods, payslips |
| messaging | 4 | 6 | 6 | Guest messages and settings, e-invoice links |
| files | 2 | 1 | 1 | Uploaded files and attachments |
| **total** | | **305** | **321** | |

Every endpoint, by owner:

- **identity**: `GET audit`, `POST auth/login`, `POST auth/logout`, `POST auth/password`, `GET auth/session`, `GET me`, `PUT me`, `GET permissions`, `PUT permissions/{}`, `GET users`, `POST users`, `PATCH users/{}`
- **property**: `GET locations`, `POST locations`, `PATCH locations/{}`, `POST properties`, `GET rate-plans`, `GET unit-blocks`, `POST unit-blocks`, `DELETE unit-blocks/{}`, `GET unit-groups`, `POST unit-groups`, `PATCH unit-groups/{}`, `PUT unit-groups/{}/rate-plan`, `GET units`, `POST units`, `PATCH units/{}`, `GET villas`, `POST villas`, `PATCH villas/{}`
- **channel**: `GET airbnb-accounts`, `POST airbnb-accounts`, `PATCH airbnb-accounts/{}`, `GET airbnb-listings`, `POST airbnb-listings`, `PATCH airbnb-listings/{}`, `PUT airbnb-listings/{}/prices`, `GET enquiries`, `POST enquiries/{}/convert`, `POST enquiries/{}/status`, `POST public/enquiries`, `GET public/site/holds`, `GET public/site/inventory`
- **reservation**: `GET booking-groups`, `POST booking-groups`, `POST booking-groups/{}/payments`, `POST booking-groups/{}/stays`, `DELETE booking-groups/{}/stays/{}`, `GET bookings`, `POST bookings`, `PATCH bookings/{}`, `POST bookings/{}/assign-unit`, `POST bookings/{}/cancel`, `POST bookings/{}/check-in`, `POST bookings/{}/check-out`, `POST bookings/{}/confirm`, `POST bookings/{}/move-unit`, `POST bookings/{}/no-show`, `PATCH bookings/{}/payment`, `POST bookings/{}/pre-checkin/verify`, `PUT bookings/{}/price`, `POST bookings/{}/settle-check-out`, `POST bookings/{}/walk`, `GET checkin/{}`, `PUT checkin/{}`, `POST checkin/{}/pay`, `GET overbooking-policies`, `GET pre-checkins`, `GET stay-restrictions`, `POST stay-restrictions`, `PUT stay-restrictions/{}`, `DELETE stay-restrictions/{}`, `POST stay-restrictions/bulk`, `PUT unit-groups/{}/overbooking`, `GET walks`
- **guest**: `POST bookings/{}/companions`, `GET foreign-reports`, `POST foreign-reports`, `GET guests`, `POST guests`, `PATCH guests/{}`, `DELETE guests/{}/blacklist`, `PUT guests/{}/blacklist`, `POST guests/{}/merge`, `GET lost-found`, `POST lost-found`, `PATCH lost-found/{}`, `POST lost-found/{}/move`, `GET lost-found/settings`, `PUT lost-found/settings`, `GET stay-companions`, `PATCH stay-companions/{}`, `DELETE stay-companions/{}`
- **billing**: `POST booking-groups/{}/city-ledger`, `PUT booking-groups/{}/city-ledger-billing`, `PUT bookings/{}/city-ledger-billing`, `GET bookings/{}/folio`, `POST bookings/{}/folio/charges`, `POST bookings/{}/folio/city-ledger`, `POST bookings/{}/folio/rebates`, `GET cashier-shifts`, `POST cashier-shifts`, `POST cashier-shifts/{}/close`, `POST cashier-shifts/{}/drop`, `POST cashier-shifts/{}/sign-off`, `GET cashier-shifts/hand-overs`, `GET cashier-shifts/policy`, `PUT cashier-shifts/policy`, `GET city-ledger/accounts`, `POST city-ledger/accounts`, `PATCH city-ledger/accounts/{}`, `POST city-ledger/accounts/{}/apply-credit`, `POST city-ledger/accounts/{}/invoices`, `GET city-ledger/invoices`, `POST city-ledger/invoices/{}/send`, `GET city-ledger/payments`, `POST city-ledger/payments`, `GET city-ledger/transfers`, `GET city-ledger/write-offs`, `POST city-ledger/write-offs`, `GET ledger/tax-settings`, `PUT ledger/tax-settings`, `GET ledger/transaction-codes`, `POST ledger/transaction-codes`, `PUT ledger/transaction-codes/{}`, `PATCH ledger/transaction-codes/{}`, `GET night-audits`, `POST night-audits`, `GET night-audits/business-date`, `GET pay/{}`, `POST pay/{}/proof`, `POST pay/{}/simulate`, `GET payment-links`, `POST payment-links`, `POST payment-links/{}/cancel`, `GET payments`, `POST payments`, `POST payments/{}/refund`, `GET payments/policy`, `PUT payments/policy`
- **finance**: `GET approval-rules`, `POST approval-rules`, `PATCH approval-rules/{}`, `DELETE approval-rules/{}`, `GET budgets`, `PUT budgets/{}/{}`, `GET cash-accounts`, `POST cash-accounts`, `PATCH cash-accounts/{}`, `GET categories`, `POST categories`, `PATCH categories/{}`, `GET ledger/accounts`, `GET ledger/category-accounts`, `PUT ledger/category-accounts/{}`, `GET ledger/journals`, `GET ledger/manual-journals`, `POST ledger/manual-journals`, `POST ledger/manual-journals/{}/approve`, `POST ledger/manual-journals/{}/post`, `POST ledger/manual-journals/{}/reject`, `POST ledger/manual-journals/{}/submit`, `GET ledger/periods`, `POST ledger/periods/{}/close`, `POST ledger/periods/{}/reopen`, `GET reconciliations`, `POST reconciliations`, `GET settings/proof-policy`, `PUT settings/proof-policy`, `GET transactions`, `POST transactions`, `POST transactions/{}/approve`, `POST transactions/{}/attachments`, `DELETE transactions/{}/attachments/{}`, `POST transactions/{}/post`, `POST transactions/{}/reject`, `POST transactions/{}/reverse`, `POST transactions/{}/submit`, `POST transactions/adjustments`, `POST transactions/transfers`
- **owners**: `GET management-contracts`, `POST management-contracts`, `PATCH management-contracts/{}`, `GET owner-portal/calendar`, `GET owner-portal/stays`, `GET owner-statements`, `POST owner-statements`, `POST owner-statements/{}/approve`, `POST owner-statements/{}/pay`, `POST owner-statements/{}/reopen`, `GET owner-stays`, `POST owner-stays`, `POST owner-stays/{}/decide`, `GET villa-owners`, `POST villa-owners`, `PATCH villa-owners/{}`
- **services**: `GET menu-items`, `POST menu-items`, `PATCH menu-items/{}`, `GET order/{}`, `POST order/{}`, `POST order/{}/pay`, `GET service-orders`, `POST service-orders`, `PATCH service-orders/{}`, `POST service-orders/{}/accept`, `POST service-orders/{}/cancel`, `POST service-orders/{}/deliver`, `POST service-orders/{}/prepare`, `POST service-orders/{}/void`, `GET service-partners`, `POST service-partners`, `PATCH service-partners/{}`, `GET service-requests`, `POST service-requests`, `PATCH service-requests/{}`, `POST service-requests/{}/cancel`, `POST service-requests/{}/done`, `POST service-requests/{}/start`
- **maintenance**: `GET assets`, `POST assets`, `PATCH assets/{}`, `GET preventive-plans`, `POST preventive-plans`, `PATCH preventive-plans/{}`, `POST preventive-plans/generate`, `GET vendors`, `POST vendors`, `PATCH vendors/{}`, `GET work-orders`, `POST work-orders`, `PATCH work-orders/{}`, `PUT work-orders/{}/block`, `POST work-orders/{}/expenses`, `PUT work-orders/{}/expenses/{}`, `POST work-orders/{}/notes`, `POST work-orders/{}/status`
- **housekeeping**: `GET housekeeping`, `PUT housekeeping/{}`, `POST housekeeping/{}/inspections`, `GET housekeeping/settings`, `PUT housekeeping/settings`, `GET housekeeping/tasks`, `POST housekeeping/tasks`, `POST housekeeping/tasks/{}/{}`, `POST housekeeping/tasks/{}/issues`, `POST housekeeping/tasks/{}/lost-found`, `POST housekeeping/tasks/assign`, `POST housekeeping/tasks/auto-assign`, `POST housekeeping/tasks/plan`, `GET laundry/batches`, `POST laundry/batches`, `POST laundry/batches/{}/return`, `POST linen/discards`, `GET linen/pars`, `PUT linen/pars/{}`, `GET linen/soiled`
- **inventory**: `POST bookings/{}/minibar-checks`, `GET stock/counts`, `POST stock/counts`, `GET stock/items`, `POST stock/items`, `PATCH stock/items/{}`, `GET stock/kits`, `PUT stock/kits/{}`, `GET stock/minibar-links`, `PUT stock/minibar-links/{}`, `GET stock/movements`, `POST stock/movements`, `GET stock/receipts`, `POST stock/receipts`, `PUT stock/receipts/{}`, `POST stock/receipts/{}/cancel`
- **people**: `GET announcements`, `POST announcements`, `PATCH announcements/{}`, `DELETE announcements/{}`, `GET attendance`, `PUT attendance`, `GET employees`, `POST employees`, `PATCH employees/{}`, `GET kpi-reviews`, `POST kpi-reviews`, `PUT kpi-reviews/{}`, `GET leave-requests`, `POST leave-requests`, `POST leave-requests/{}/approve`, `POST leave-requests/{}/cancel`, `POST leave-requests/{}/reject`, `GET loans`, `POST loans`, `POST loans/{}/approve`, `POST loans/{}/cancel`, `POST loans/{}/reject`, `GET overtime-requests`, `POST overtime-requests`, `POST overtime-requests/{}/approve`, `POST overtime-requests/{}/cancel`, `POST overtime-requests/{}/reject`, `GET shift-assignments`, `PUT shift-assignments`, `GET shifts`
- **payroll**: `GET payroll/periods`, `POST payroll/periods`, `POST payroll/periods/{}/approve`, `POST payroll/periods/{}/calculate`, `POST payroll/periods/{}/close`, `POST payroll/periods/{}/lines/{}/adjustments`, `POST payroll/periods/{}/lines/{}/adjustments/{}/remove`, `POST payroll/periods/{}/publish`, `POST payroll/periods/{}/reopen`, `GET payroll/settings`, `PUT payroll/settings`
- **messaging**: `GET invoice/{}`, `GET messages`, `POST messages`, `POST messages/{}/resend`, `GET messages/settings`, `PUT messages/settings`
- **files**: `POST files`

## People and payroll (phase 4)

Two contexts, `internal/people` (schema `people`, `cmd/people`) and `internal/payroll` (schema
`payroll`, `cmd/payroll`), implement every endpoint the table assigns them: 30 for people and 11 for
payroll. Rules, codes and wording come from `src/domain/hr.ts`, `people.ts`, `payroll.ts`, the hr,
payroll and people parts of `src/application/services.ts` and the mock adapter. Cashier shifts
belong to billing, not here.

Storage. Each record kind is a table of JSON documents (`data jsonb`) with the columns the rules
and filters need: `employee_id`, a natural `key` (an employee's code, a roster or attendance day, a
KPI quarter, each unique where the mock keeps one per key), `villa_ids` and `location_ids` for
employees and notices, `version` and `seq`. People's reads are views over those tables (`v_*`).
Numbers follow the mock's `seq()` through a `counters` table (`LV-209`, `OT-311`, `LN-404`,
`emp-016`, `adj-1`). The published types in `people/events.go` and `payroll/events.go` are the
records themselves; each domain package aliases them.

Who reads what. A user with `hr/view` or `payroll/view` reads every employee who works at a villa
in their scope and those employees' records. Anyone else reads their own employee record,
roster, attendance, requests and reviews only (the employee area), found through the login's
`employeeId`. `GET /payroll/periods` gives `payroll/view` holders every period, narrowed to the
payslips of employees in scope for a scoped user; anyone else gets the periods with their own
payslip once it is published. Shifts, payroll settings and announcements (everyone's plus the
villas in scope) are open to every signed-in user.

| Endpoint | Needs |
| --- | --- |
| `POST /employees` | hr/create, every allocated villa in scope |
| `PATCH /employees/{id}`, `PUT /shift-assignments`, `PUT /attendance`, `PUT /kpi-reviews/{id}`, `POST /kpi-reviews` | hr/edit, the employee in scope |
| `POST /leave-requests`, `/overtime-requests`, `/loans` | yourself, or hr/view or payroll/view and the employee in scope |
| `POST /leave-requests/{id}/approve\|reject`, `/overtime-requests/...` | hr/approve, the employee in scope |
| `POST /loans/{id}/approve\|reject` | payroll/approve, the employee in scope |
| `POST .../cancel` | the requester, or the approve permission |
| `POST /announcements` | hr/create; `PATCH`, `DELETE` hr/edit |
| `PUT /payroll/settings`, `POST .../calculate`, `.../adjustments`, `.../remove`, `.../reopen`, `.../publish` | payroll/edit |
| `POST /payroll/periods` | payroll/create |
| `POST .../approve` | payroll/approve, not the person who calculated it (`APPROVAL_SELF`) unless the owner |
| `POST .../close` | payroll/post and an `accountId` |

Refusal codes: `REQUEST_INVALID_STATE`, `PAYROLL_EXISTS`, `PAYROLL_LOCKED`,
`PAYROLL_INVALID_STATE`, `APPROVAL_SELF`, and `VALIDATION_ERROR` with the validators' messages.

Events and reactions:

- People publishes `people.employee.saved.v1` (with the location of each allocated villa),
  `people.shift.saved.v1`, `people.shift_assignment.saved.v1`, `people.attendance.recorded.v1`,
  `people.leave.saved.v1`, `people.overtime.saved.v1`, `people.loan.saved.v1`,
  `people.announcement.saved.v1`, `people.announcement.removed.v1` and `people.kpi_review.saved.v1`.
- People projects `property.villa.*` into `people.rm_villas` (name and location for scope checks and
  messages); consumer `people.villas`.
- Payroll projects employees, attendance, overtime and loans into `payroll.rm_*` and computes
  payslips from those copies; consumer `payroll.people`.
- Payroll publishes `payroll.settings.saved.v1`, `payroll.period.saved.v1` and, on close,
  `payroll.period.closed.v1`. People books the loan repayments from the closed event (consumer
  `people.loan-repayments`): each line's loan deduction pays down the employee's active loans
  oldest first and settles a loan repaid in full. Approving leave marks the days up to today as
  leave on the attendance sheet in the same transaction.

Cross-context clients and the gaps they cover (finance and billing are not built yet):

- `command.PayrollPosting.PostSalaryPayment` posts a closed period's salary payment. The in-process
  client (`payroll/adapters/finance.Outbox`) appends `payroll.period.closed.v1` to the outbox in the
  closing transaction with every amount: the account, category `cat-payroll` and reference
  `PAY-<month>`, the totals, the cost per villa for the journal, the BPJS and PPh 21 owed with the
  categories and references the remittance cash-outs use (the statutory prefill), and every
  payslip. It returns no transaction id, so `transactionId` stays null and no bank balance moves,
  no ledger period is checked and the account id is not verified until finance consumes the event.
  A finance client that posts directly must still leave that event in the outbox, because people
  books repayments from it.
- `command.ServicePool.BilledServiceCharge` answers the month's Service charge payable from the
  folio. The in-process client (`payroll/adapters/billing.NoPool`) answers zero, so a calculation
  sets `revenueBase` to 0 and pays no service charge share until billing replaces it. Seeded
  periods keep the shares the mock computed.

Split mode runs `people` and `payroll` behind the gateway (`@people`, `@payroll` in the Caddyfile);
both read the matrix and renew sessions through identity like property. Seed: `export-seed.mjs`
writes `seed/people.json` and `seed/payroll.json`; `cmd/seed` shifts days by the day difference,
months (`startMonth`, period months and ids) by the month difference and KPI quarters by the
quarter difference (`clock.ShiftFor`).

## Finance context (phase 2)

`internal/finance` owns the cash ledger (cash accounts, petty cash per villa, categories, cash
entries and their approval chain, transfers, balance adjustments, cash counts), the double-entry
books (chart, category mapping, journals, manual journals, period close) and budgets, on the
`finance` schema: the 40 endpoints the ownership table gives it. Rules and wording come from
`finance.ts`, `approval.ts`, `attachment.ts`, `journal.ts` and the mock's finance, ledger and budget
adapters. Billing owns cashier shifts, the tax settings and the transaction codes; finance keeps a
copy of the codes and the tax settings from billing's events and books what billing's shifts move.

| Endpoint | Needs |
| --- | --- |
| `GET /cash-accounts`, `/transactions`, `/reconciliations`, `/budgets` | signed in, scoped as `financeWorld`: petty cash follows its villa, a cashbox its location (a villa-scoped user sees the locations of their villas), the bank everyone |
| `GET /categories`, `/approval-rules`, `/settings/proof-policy`, `/ledger/accounts`, `/ledger/category-accounts`, `/ledger/periods` | signed in |
| `GET /ledger/journals`, `/ledger/manual-journals` | finance/view, else an empty list (the room service menu reads journals for everyone); a restricted user sees their villas' entries |
| `POST /cash-accounts`, `PATCH /cash-accounts/{id}`, `POST`, `PATCH /categories` | master/create, master/edit (`CATEGORY_SYSTEM`) |
| `POST /transactions` | finance/submit to submit, finance/create to draft; account and location in scope; `PROOF_REQUIRED`, `ATTACHMENT_*` |
| `POST /transactions/{id}/submit\|approve\|reject\|post` | finance/submit, approval/approve, approval/approve, finance/post; `APPROVAL_SELF`, `APPROVAL_ROLE`, `TRANSACTION_INVALID_STATE`, `TRANSACTION_ALREADY_POSTED`, `PERIOD_CLOSED` |
| `POST /transactions/{id}/reverse` | finance/post and a reason |
| `POST /transactions/transfers`, `/transactions/adjustments`, `/reconciliations` | finance/submit |
| `POST`, `DELETE /transactions/{id}/attachments` | finance/create; `ATTACHMENT_LOCKED` once posted |
| approval rules | approval/create, approval/edit |
| proof policy, category mapping | finance/edit (`LEDGER_ACCOUNT_INVALID`, `CATEGORY_FOLLOWS_CODE` with `billing.CategoryCode`) |
| manual journals | finance/create or submit, approval/approve, finance/post; a journal signs like a cash-out of its total |
| `POST /ledger/periods/{month}/close\|reopen` | finance/post; `PERIOD_NOT_ENDED`, `PERIOD_CLOSED`, `PERIOD_PENDING`, `PERIOD_OPEN` |
| `PUT /budgets/{villaId}/{year}` | finance/edit and the villa in scope (`FORBIDDEN` with the mock's wording) |

**Storage.** Each record keeps the console's JSON in `doc`; reads come from the write tables, so a
read equals the mock's. Transactions keep `source_type` and `source_id`, the record of another
context an entry was written for. `refs` keys every record finance made from another context's
fact by that fact's id (a payment, a posting, a write-off, a payout request, a shift), so a replay
makes nothing twice and `ApprovalStatus` answers by it. `entry_links` keeps what the posting rules
read about an entry (payment shares, order money, a service request, the partner a bill pays),
`payroll_postings` the totals of a salary payment, `payroll_costs` each villa's share of a closed
payroll, `stays` each booking's state and first billed day. `cat_villas` and `cat_locations`
(consumer `finance.catalog`) copy property's events. Commands lock rows with `FOR UPDATE`; posting,
closing and reopening take one advisory lock, so nothing posts into a month while it closes.

**The books.** Every posted entry writes its journal once per source with `domain.JournalFor`, a
port of `journalFor`: one entry for both halves of a transfer, the payroll entry for a salary
payment, the guest money rules (room money on Guest deposits until the room is first billed, then
on the receivable; order and charge money on the receivable; a cancelled stay by category), a
partner bill on the partner's payable, else the category's account. A reversal writes the turned
entry. The seed carries the journal exactly as `buildJournals` wrote it. The `domain` tests rebuild
every seeded cash entry's journal with the Go rules, and hold the seeded books and the books after
HTTP commands to the `accounting.test.ts` invariants (`domain.BooksProblems`): every entry
balances, the trial balance nets to zero and the balance sheet balances at every month end, and
every cash GL account equals its cash ledger balance.

**Events published.** `finance.entry.approved.v1`, `finance.entry.rejected.v1`,
`finance.entry.posted.v1` and `finance.entry.reversed.v1` carry the entry (`finance.Entry`:
`transactionId`, `number`, `status` and the rest) with `source` (`{type, id}`), `sourceRef` (the id
of the fact it was made from, a payout request's `sourceRef` among them; empty for an entry staff
wrote), who and when; both halves of a transfer publish. Owners follows payouts by them.
`finance.cash_out.decided.v1` answers maintenance and inventory (below).

**Events consumed.** Each policy runs in the projector's inbox transaction and checks `refs` or its
source before writing. An event finance cannot book (an unknown account, a closed month for a
journal) is skipped rather than retried.

| Event | Consumer | Writes |
| --- | --- | --- |
| `billing.payment.recorded.v1` | `finance.billing` | `bookMoney`: the cash-in on `cashAccountId` (per `revenue` category for room service money), stamped with `shiftId`, and the `fee` as a `cat-fees` cash-out; the shares of one `batch` land as one cash-in and one fee entry |
| `billing.payment.refunded.v1` | `finance.billing` | the refund cash-out; a refund of order money keeps paying back the receivable |
| `billing.folio_line.posted.v1` | `finance.billing` | `chargeJournal` on the line's `account` (a transfer books from `city_ledger.transferred`) |
| `billing.folio_line.voided.v1` | `finance.billing` | the order's lines turned around on the day of the void |
| `billing.night.audited.v1` | `finance.billing` | `nightJournal` per stay, the first posting moving the deposits held; the stay's first billed day |
| `billing.stay.checked_out.v1` | `finance.billing` | the `folioCharges` a settle took as a `cat-extra` cash-in, departure charges on DMG, and `stayJournal` for the `roomLines` and the deposits held |
| `billing.city_ledger.transferred.v1`, `.invoice_issued.v1` | `finance.billing` | the transfer journal per part and the agent commission |
| `billing.city_ledger.payment_received.v1` | `finance.billing` | the City ledger cash-in for approval |
| `billing.city_ledger.written_off.v1` | `finance.billing` | the write-off as a submitted manual journal (bad debt against the city ledger) |
| `billing.tax_settings.changed.v1`, `billing.transaction_code.saved.v1` | `finance.billing` | finance's copy of the tax settings and the codes (`codeAccount`) |
| `billing.cashier_shift.closed.v1` | `finance.billing` | the cash count with its difference as an adjustment for approval |
| `billing.cashier_shift.dropped.v1` | `finance.billing` | the drop through the transfer path, kept off every shift |
| `owners.statement.closed.v1`, `.reopened.v1` | `finance.owners` | the close entry owners worked out, and its reversal |
| `owners.payout.requested.v1` | `finance.owners` | the payout cash-out or top-up cash-in for approval, keyed by `sourceRef` |
| `payroll.period.closed.v1` | `finance.payroll` | the salary cash-out (`cat-payroll`, `PAY-<month>`) recorded posted with the payroll approval, the payroll journal (wages and employer BPJS against the bank, BPJS payable, PPh 21 payable and employee loans, the service charge shares paying Service charge payable down) and each villa's cost; in a closed month the entry stays approved until the month reopens |
| `reservation.booking.saved.v1`, `.status_changed.v1` | `finance.reservation` | the stay copy; a stay cancelled or marked no-show keeps its deposits held as room revenue |
| `reservation.walk.recorded.v1` | `finance.reservation` | the relocation cost as a `cat-relocation` cash-out for approval |
| `maintenance.expense.submitted.v1`, `inventory.purchase.submitted.v1` | `finance.maintenance`, `finance.inventory` | the cash-out for approval under the id the request carries, numbered by finance |
| `maintenance.expense.resubmitted.v1`, `inventory.purchase.resubmitted.v1` | same | the corrected fields on the rejected entry, sent back to the first level |
| `housekeeping.laundry.billed.v1` | `finance.housekeeping` | the laundry vendor's bill as a cash-out for approval (source `laundry`, the batch id), numbered and identified by finance |
| `inventory.purchase.cancelled.v1` | `finance.inventory` | marks the rejected entry given up: resubmitting it from the ledger is refused (`TRANSACTION_INVALID_STATE`) |
| `services.order.delivered.v1` | `finance.services` | `orderJournal` as one entry, source `order` and the order id, keyed `order-delivered:<id>` in `refs`: each of `codes` on the stay's receivable against its code's account, with service and PB1 split out of the menu price (`domain.InclusiveSplit` on finance's copy of the tax settings, the split billing's folio and its void use); then Dr Service partner costs (5100), Cr Payables to service partners (2200) per partner with its `partnerId`. Billing posts no folio line for a delivery, so the revenue is booked only here. Then one bill per partner (`cat-svc-partner`, from the bank, origin `room_service`, `"<SO-number> <partner>: <items>"`, written by `by` of the event) submitted for approval, source `service_order` and the order id, the partner in `entry_links`; posting a bill pays the partner's payable down |
| `services.order.voided.v1` | `finance.services` | the order's bills still waiting rejected (`SO-715 voided`), and the delivery's partner lines turned around on the void day (`order-voided:<id>`); `billing.folio_line.voided.v1` reverses the revenue under `folio-void:<id>` |

A hand-written cash-out another context asks for without its receipt is kept rejected with the
`PROOF_REQUIRED` wording, so the asking context attaches the receipt and publishes again; the
client's `ProofPolicy` lets it check first.

**Maintenance and inventory cash-outs.** Finance keeps the provisional id the request carries
(`tx-m12`, `tx-s12`) as the entry's id, so work order expenses and stock receipts keep pointing at
it and vendor spend and asset repair cost read the entry and its reference (`WO-...`, the
supplier's reference). Finance numbers the entry from its own sequence (`TX-2641`). Booking the
entry for approval and every status change after publish `finance.cash_out.decided.v1` with `{
transactionId, number, status, rejectionReason, version, sourceType, sourceId, partnerId }`, the
payload `maintenance.CashOutDecided` and `inventory.CashOutDecided` read (the first carries status
`submitted`). A returned laundry batch's bill publishes it too; housekeeping gave the request no
id, so it finds its batch by `sourceType` `laundry` and `sourceId`, and shows the entry as soon as
finance books it. A partner bill publishes it with `sourceType` `service_order`, the order as
`sourceId` and the partner as `partnerId`; services keeps it (below).

**Finance client.** `finance.Client` (`internal/finance/client.go`): in process from
`module.Client()`, else `finance.HTTPClient` to `FINANCE_URL` with `INTERNAL_TOKEN`, under
`/internal/v1/finance`.

| Method | Route | Answers |
| --- | --- | --- |
| `Entries(ctx, source)` | `GET /entries?sourceType=&sourceId=` | the entries written for a source record, with their status |
| `ApprovalStatus(ctx, ref)` | `GET /approval-status?ref=` | where the record made from a fact stands; `submitted` while finance has not booked it |
| `AssertOpen(ctx, date)` | `GET /open-period?date=` | 204, or `PERIOD_CLOSED` |
| `CashAccounts(ctx)` | `GET /cash-accounts` | `id`, `name`, `kind`, `locationId` |
| `ShiftCash(ctx, shiftId, accountId)` | `GET /shift-cash` | the cash in and out of the entries stamped with the shift on its cashbox |
| `ProofPolicy(ctx)` | `GET /proof-policy` | the receipt threshold |
| `BilledServiceCharge(ctx, month)` | `GET /service-charge?month=` | `payableBilled` on Service charge payable (2400) for the month |
| `VillaBooks(ctx, villaId, month)` | `GET /villa-books` | the villa's posted entries by their villa P&L role, its payroll share, the entries still waiting |

The composition root gives billing a `command.Finance` over this client (`bootstrap.billingFinance`,
billing's `PendingFinance` where finance does not run), payroll its service charge pool, and owners
`owners.Results`: the stays from owners' own stub with the entries, payroll and pending count from
`VillaBooks`.

**Gaps.** Billing's check-out fact does not say whether a settle or a plain check-out closed the
stay, so finance books only the folio charges a settle took; the deposit returned and the departure
charges reach the ledger through the console's own `POST /transactions` on a plain check-out. It
carries no Airbnb fee either, so the check-out entry books none. Entries the ledger records by hand carry no cashier shift:
billing owns the open shift, so only the money it sends with a `shiftId` counts in `ShiftCash`.
Files: `POST /transactions/{id}/attachments` and manual journals that send only `attachmentIds`
answer `NOT_AVAILABLE`, since the files context resolves no ids for other contexts yet.

**Seed.** `seed/finance.json` holds the mock's finance state after `buildState`, the journal
included, plus the stays, entry links, sources, refs and payroll costs the posting rules and the
client read. `cmd/seed` loads it after property's events are projected, moves dates by days and
payroll months and their references by months, and writes no events.

**Not ported.** The views the console computes from the reads (statements, ledgers, the approvals
inbox, PB1 and statutory remittance lists, reports) stay in the console: it builds them from
`ledger/journals`, `ledger/accounts` and `transactions`, and statutory remittances post through
`POST /transactions`.

## Guest context (phase 1)

`internal/guest` owns guest profiles, the blacklist, duplicates and merge, stay companions, the
Immigration (APOA) register and lost and found, on the `guest` schema. Rules and wording come from
`src/domain/guest.ts`, `src/domain/lostFound.ts` and `src/infrastructure/mock/guests.ts`; the
domain tests port the cases of `src/application/guests.test.ts`.

| Endpoint | Needs |
| --- | --- |
| `GET /guests`, `GET /guests/duplicates` | signed in; profiles are shared across villas, so the booking form finds a returning guest in any villa |
| `POST /guests` | guest/create or booking/create (the booking form creates guests) |
| `PATCH /guests/{id}` | guest/edit or booking/edit; optional fields left out keep their value, `null` clears |
| `PUT`, `DELETE /guests/{id}/blacklist` | guest/edit, then guest/approve (`FORBIDDEN`, "Only someone who may approve in the guest module can change the blacklist.") |
| `POST /guests/{id}/merge` | guest/edit, then guest/approve; publishes `guest.merged.v1` |
| `GET /stay-companions`, `GET /foreign-reports`, `GET /lost-found` | signed in, filtered to the stay's or item's villa scope |
| `POST /bookings/{id}/companions`, `PATCH`, `DELETE /stay-companions/{id}` | guest/edit, the stay in scope and open (`BOOKING_INVALID_STATE`) |
| `POST /foreign-reports` | guest/edit, the stay checked in; `ALREADY_REPORTED` when everyone picked is reported |
| `GET /foreign-guests?date&villaId` | guest/view; the day's foreign adults with `missing`, `report`, `dueAt`, `overdue` and the APOA rows in `APOA_COLUMNS` order |
| `POST /lost-found` | guest/create, villa in scope, unit in that villa, a stay's guest wins |
| `PATCH /lost-found/{id}`, `POST /lost-found/{id}/move` | guest/edit; a move off `LOST_TRANSITIONS`, a return without receiver or tracking, or disposal inside the holding period is `LOST_ITEM_INVALID_STATE` |
| `GET`, `PUT /lost-found/settings` | read signed in; save needs guest/edit and guest/approve, 7 to 365 days |

**Storage.** Each aggregate row keeps its full JSON state in `doc` next to the columns rules look up
(`booking_id`, `villa_id`, `guest_id`), with `version` for optimistic concurrency. Reads go through
views (`guest.v_guests`, `v_companions`, `v_foreign_reports`, `v_lost_items`, `v_stays`) that add the
villa and location for the scope filter. `guest.counters` is the mock's `seq()`, so ids continue the
seed (`g-27`, `cmp-5`, `fr-267`, `lf-7`, `LF-007`).

**What guest knows of other contexts.** Property events feed `guest.rm_villas`, `rm_units` and
`rm_locations` (consumer `guest.property`): villa names for audit lines and APOA addresses, unit
codes for the room column, the location for the scope filter. Booking facts live in
`guest.rm_stays` (id, code, lead guest, unit, villa, status, dates, arrival time, adults) and group
leads in `guest.rm_group_leads`. `cmd/seed` fills both from `seed/guest.json`. When the reservation
context publishes booking and group events, guest registers projections into these two tables
under a `guest.reservation` consumer; until then a booking created through the API is unknown to
guest, so companions and reports on it answer `NOT_FOUND`.

**Merge.** Guest moves what it owns inside the merge transaction: lost items (`guest_id` and the
document), Immigration report lines (a stay that already reports the kept guest keeps that line),
and its own copies of stays and group leads, which it counts for the audit line. It then appends
`guest.updated.v1` for the kept profile and `guest.merged.v1`:

```json
{ "keepId": "g-16", "dropId": "g-26", "guest": { "id": "g-16", "name": "Sarah Cohen", ... },
  "movedLostItems": ["lf-4"], "movedReportsFor": ["bk-..."] }
```

Consumers re-point every reference to `dropId`: reservation moves `bookings.guestId` and
`booking_groups.leadGuestId`; billing, messaging and services re-point any guest id they keep.
Handlers must be idempotent (an `UPDATE ... WHERE guest_id = dropId` is).

**Events.** `guest.created.v1`, `guest.updated.v1` (blacklist changes included), `guest.merged.v1`,
`guest.companion.added.v1`, `guest.companion.updated.v1`, `guest.companion.removed.v1`,
`guest.foreign_report.recorded.v1`, `guest.lost_item.logged.v1`, `guest.lost_item.updated.v1`,
`guest.lost_item.moved.v1`, `guest.lost_found_settings.saved.v1`. Payloads are in
`internal/guest/events.go`.

**Guest client.** `guest.Client` (`internal/guest/client.go`) is what other contexts call. The
composition root puts it on `App.Guest`: the in-process implementation (`module.Client()`, the
query handlers) when guest runs in the process, else `guest.HTTPClient` to `GUEST_URL` with
`INTERNAL_TOKEN`. Refusals come back as `*errs.Error` with guest's codes and wording.

| Method | Route (`/internal/v1`) | Answers |
| --- | --- | --- |
| `Guest(ctx, id)` | `GET /guests/{id}` | name, contact, nationality, VIP, allergies, blacklist; `NOT_FOUND` |
| `BlacklistStatus(ctx, id)` | `GET /guests/{id}/blacklist` | `{ guestId, name, blacklisted, blacklist }`; reservation refuses with `GUEST_BLACKLISTED` |
| `Registration(ctx, stay)` | `POST /registrations` | lead guest and companions with `missing` and `expired`, registered adults, unregistered adults |
| `CheckRegistration(ctx, stay)` | `POST /registrations/check` | 204, or `FOREIGN_DATA_MISSING` / `DOCUMENT_EXPIRED` for the check-in |
| `CreateGuest(ctx, p, input, key)` | `POST /guests` (`{ principal, input, key }`) | the new profile; guest/create or booking/create; a repeated key returns the first profile |

`stay` is `guest.StayPeople{BookingID, GuestID, Adults, On}`.

## Reservation context (phase 1)

Reservation owns the 32 endpoints in the ownership table: bookings and their lifecycle, groups, stay
restrictions, the overbooking policy and walks, and the online check-in (`pre-checkins`,
`checkin/{token}`). Rules and wording come from `booking.ts`, `group.ts`, `restriction.ts`,
`overbooking.ts`, `pricing.ts`, the rate plan pricing in `ratePlan.ts`, `cancellationTerms` in
`payment.ts`, `precheckin.ts` and the mock's booking, groups and stay rules adapters.

**Storage.** Each write row keeps the console's JSON in `doc` (a `Booking`, `BookingGroup`,
`Restriction`, `Walk`, `PreCheckIn`) beside the columns availability and the locks query (unit,
assignment, status, dates, group, check-in token), with `version` for optimistic concurrency.
`reservation.counters` continues the mock's `seq()` (`BK-3001`, `GRP-1003`, `WLK-101`, `rst-1`).
Every command that changes what holds a unit takes one transaction advisory lock first, so two
bookings never pass the same availability check. Reads come from `rm_*` tables kept from
reservation's events, each row with its villas and locations for the scope filter.

**What reservation knows of other contexts.**

| Need | Source |
| --- | --- |
| Units, room types, villas, locations, rate plans, unit blocks | property events, projected into `reservation.cat_*` (consumer `reservation.catalog`) |
| Live listing prices for a direct stay | `channel.Prices` (`ActiveListing`), through `clients.Listings`; without a channel the rate plan prices the night |
| Blacklist (`GUEST_BLACKLISTED`), check-in registration (`FOREIGN_DATA_MISSING`, `DOCUMENT_EXPIRED`), a verified online check-in's profile and companions | `guest.Client`, through `clients.Guests` |
| Guest merges | `guest.merged.v1` (consumer `reservation.guest`) moves `guestId` and `leadGuestId` in the write and read models |
| Payment policy (discount limit, deposit, free cancellation days), tax mode and rates | billing's `Policy` through `clients.BillingSettings`; the TypeScript defaults while no billing runs |
| Folio holds at check-out, room balance, payments, links, city ledger | `billing.Client` through `clients.Billing`; `clients.PendingBilling` answers `NOT_AVAILABLE` while no billing runs |
| Paid amounts, posted nights, who pays | billing's events (consumer `reservation.billing`, `command.FollowBilling`) |

**Late check-out.** `POST /bookings/{id}/late-checkout` keeps `lateCheckout { until, charge, by, at }`
on the stay and appends `reservation.late_checkout.granted.v1` in the same transaction: `{ bookingId,
bookingCode, unitId, villaId, locationId, until, code: LATE, description, charge, by, byId, at }`.
Billing posts the charge from that event (consumer `billing.late-checkout`, `command.LateCheckoutCharged`)
as the person who gave the late check-out; `billing.late_checkouts` keys one posting per stay, so a
redelivered or replayed grant posts nothing more, and a free one (`charge` 0) posts nothing. A
refused commit leaves no charge behind, which the earlier synchronous `PostCharge` call to billing
could. The answer stays `{ booking, charge }`; in the monolith the read-your-writes middleware holds
it until billing applied the event, so the folio read next shows the charge. A split reservation
answers before billing posts it.

A guard whose context does not run passes (no folio, no listing, no guest record exists to refuse),
and work only that context can do answers `NOT_AVAILABLE` (503): a booking or group with
`newGuest` while no guest runs. Billing closed the money gaps in phase 2: a group deposit, `booking-groups/{id}/payments`,
`settle-check-out`, `checkin/{token}/pay` and a `cityLedger` billing on a new booking go through
`billing.Client`, and answer `NOT_AVAILABLE` only in a deployment without billing. A booking or group with `newGuest` creates the profile
through `guest.Client.CreateGuest` before it writes the stay. In the monolith both share one
transaction. In split mode the profile commits on guest first; reservation passes the key
`reservation:<userId>:<Idempotency-Key>`, and guest keeps it in `guest.creation_keys`, so a retry that
reaches guest again returns the first profile. A booking refused after the profile was created in
split mode leaves that profile behind. Verifying an online check-in sets the stay's party and calls
`guest.Client.ApplyPreCheckIn` (in process, or `/internal/v1/pre-checkins` with `GUEST_URL`): guest
copies the lead traveller's contact and document onto the profile and turns the other travellers
into companions, updating one whose document number is already on the stay, as the mock's
`guestFieldsFrom` and `companionFieldsFrom` do. Reservation's audit line names the companions.

**List order.** The lists follow the mock's array order, never the order the projector saw rows in
(two relays draining one outbox can interleave): bookings by the number in their id, stay
restrictions by the write model's `seq` (copied to `rm_restrictions.position`), id breaking ties.

**Events.** Every payload is a `reservation.Record` (`id`, `villaIds`, `locationIds`, `data` in the
console's shape): `reservation.booking.saved.v1`, `booking.status_changed.v1` (adds `from`, `to` and,
for a direct stay cancelled or marked no-show, the cancellation `terms`; a walk out refunds
everything), `booking_group.saved.v1`, `restriction.saved.v1`, `restriction.removed.v1`,
`overbooking.set.v1`, `walk.recorded.v1` (finance books the relocation cost from it) and
`pre_checkin.saved.v1`. Guest projects booking and group events into `guest.rm_stays` and
`guest.rm_group_leads` (consumer `guest.reservation`).

**Answers to other contexts.** Property's `command.Stays` (`UNIT_IN_USE`, `ROOMS_TO_ASSIGN`,
`BLOCK_OVERLAP`) reads `reservation.bookings` in process, or `/internal/v1/stays/overlap`,
`/upcoming` and `/waiting` through `property/adapters/stays.HTTP` in split mode. Channel's
`command.Bookings` and the stays and restrictions of `query.SiteSources` come from
`reservation.Site` through `bootstrap.siteSources`, or over `/internal/v1/site` through channel's
`sources.Reservation` in split mode.

**Permissions.** The services check nothing before a lifecycle step, a move, new dates, notes or the
payment summary; the API asks booking/edit there. Create asks booking/create, groups booking/create
(and payments/create with a deposit), restrictions and overbooking property/edit, a walk and the
pre-check-in verify booking/edit, group payments payments/create. The check-in link is public.

**Rooms and villas.** A unit's kind is its room type's (`cat_unit_groups.kind`), or without one a
room in a hotel and a villa otherwise (`Catalog.UnitKind`). Check-in words the key step by kind
and records `depositAsked` from the property's `depositOnCheckIn` (villa units only in a mixed
property). `POST /whole-villa-bookings` (`command.CreateWholeVilla`) books every villa unit of a
villa with `wholeRental` as one `BookingGroup` with `wholeVilla: true` on a master folio, through
`createStay` and `saveGroup` like any group: `WHOLE_VILLA_NOT_ALLOWED`, `WHOLE_VILLA_UNAVAILABLE`,
`UNIT_CAPACITY` on the summed capacity. A room type's starting minimum stay from the New property
wizard arrives in `property.property.created.v1` (`minStays`); `command.WizardMinStays` (consumer
`reservation.catalog`) saves each above one night as a yearly `min_stay` restriction with id
`rst-min-<groupId>`, so a redelivery adds nothing.

**Not ported.** Presentation helpers the console computes from the reads (`lifecycleSteps`,
`nightState`, `occupancy`, `filterBookings`, `sortBookings`, `dayMarks`), the master folio and every
money movement (billing), the unregistered-adults note on check-in (guest's `Registration`), guest
messages on status changes (messaging) and the deposit, departure and relocation cash entries
(finance).

## Housekeeping context (phase 3)

`internal/housekeeping` owns the 20 housekeeping endpoints: the board (`GET /housekeeping`,
`PUT /housekeeping/{unitId}`, `POST /housekeeping/{unitId}/inspections`), the settings, room tasks
with credits and standards, the day plan, assignment and auto-assign, the attendant's work on the
phone, linen pars, soiled bags and laundry batches. Rules and wording come from
`src/domain/housekeeping.ts`, the board half of `src/domain/maintenance.ts`, the mock's
`housekeeping.ts` and the board calls in `mock/index.ts`; the tests port
`src/application/housekeeping.test.ts`.

| Endpoint | Needs |
| --- | --- |
| every `GET` | signed in, filtered to the villa scope |
| `PUT /housekeeping/{unitId}`, inspections | maintenance/edit; a skipped stage or an inspection outside cleaning is `HOUSEKEEPING_INVALID_STATE` |
| settings, plan, add, assign, auto-assign, pars, discards, laundry | maintenance/edit |
| `POST /housekeeping/tasks/{id}/{action}`, `/lost-found` | maintenance/submit; attendants work their own list (`TASK_NOT_YOURS`), a supervisor (maintenance/approve) or a login without an employee works any |
| `POST /housekeeping/tasks/{id}/issues` | maintenance/create, then the same worker check |
| laundry return | maintenance/submit with a bill, edit without one, then the mock's supervisor check ("Only housekeeping supervisors assign rooms and keep the linen.") |

Refusals keep the mock's codes: `TASK_INVALID_STATE` (a step off the task's state machine, a guest
answer on a task without a guest, a departure while the stay is still in), `TASK_NOT_YOURS`,
`NOT_ON_SHIFT`, `LINEN_SHORT`, `LAUNDRY_INVALID_STATE`, `HOUSEKEEPING_INVALID_STATE`.
`domain.AutoAssign` is `autoAssign` line for line: villas with the most credits first, one attendant
per villa when the work fits, the location's attendants when nobody serves the villa, never past
the quota. `domain.DNDStreak` and `DNDAlertDays` are ported for the alert the console works out.

**Storage.** Tasks, board records, pars and batches keep the console's JSON in `doc`; soiled bags
are counts per villa and item. Reads come from these tables (consistent at once).
`housekeeping.counters` continues the mock's numbers (`hkt-115`, `HK-4115`, `LDY-203`).

**What housekeeping knows of other contexts.**

| Need | Source |
| --- | --- |
| Units, room types, villas | property events, projected into `housekeeping.cat_*` (consumer `housekeeping.catalog`) |
| Stays for the plan, the departure guard and the stay in house | reservation booking events into `housekeeping.stays` (consumer `housekeeping.reservation`) |
| A business date opening, the date planned on start | `billing.night.audited.v1` (consumer `housekeeping.night-audit`); `billing.Client.BusinessDate` on start (see "Automatic day plan") |
| A room checked out turns dirty | `reservation.booking.status_changed.v1` with `to: checked_out` (same consumer); the console also sends `PUT /housekeeping/{unitId}` dirty after a check-out, which then keeps the state |
| Employees, roster, leave (`NOT_ON_SHIFT`, auto-assign) | people's `employee.saved`, `shift_assignment.saved` and `leave.saved` events, projected into `housekeeping.staff_*` (consumer `housekeeping.people`); `postgres.Staff` answers `command.People` |
| Stock item names and kinds (`LINEN_SHORT` wording, linen-only pars) | `command.Stock` through `clients.Stock` and the published `inventory.Items`: in process `inventorymodule.Client()`, else `GET /internal/v1/stock/items` on `INVENTORY_URL`. It reads the live list, so an item added on the stock page counts at once; without inventory the item id stands in and the kind check passes |
| Work orders from an inspection or a task issue | `command.WorkOrders`; maintenance offers no way for another context to open a work order yet, so `clients.PendingWorkOrders` answers `NOT_AVAILABLE` (503) for `raiseWorkOrder` and `POST .../issues`. Maintenance needs an in-process call and `/internal/v1/work-orders` taking `{ villaId, unitId, source: "inspection", category, priority, title, description }` and answering `{ id, number }` |
| A find on a task | `guest.LostFound` (new, additive): in process `guestmodule.LostFound()`, else `POST /internal/v1/lost-found/finds` on `GUEST_URL`; it logs the item in the attendant's name with guest's scope, unit and stay checks, without guest/create |

**Stayover cleans.** The day plan (`POST /housekeeping/tasks/plan`, the trigger that also makes the
departure cleans) gives a stay in house a stayover clean every `stayoverEvery` days after arrival
(never on the arrival or departure day), from the villa's `stayoverEvery` on `cat_villas`; a mixed
property cleans its room-kind units only (`domain.StayoverEvery`). `housekeeping.planned_stayovers`
keys one planned stayover per unit per day, so planning the day again, or twice at once, adds none.
A stayover added by hand is not keyed.

**Automatic day plan.** Housekeeping plans a business date by itself through the same command
(`command.PlanDay.Once`, signed "Day plan", every villa): when billing's night audit opens it
(`billing.night.audited.v1`'s `nextBusinessDate`, consumer `housekeeping.night-audit`) and on start
for the current business date (`App.PlanBusinessDay`, after the copies caught up), which billing
answers through `billing.Client.BusinessDate` in process or on `BILLING_URL`, else the clock's
date. `housekeeping.planned_days` marks a planned date: the automatic plan runs once per date, and a
supervisor's `POST /housekeeping/tasks/plan` marks the date too but always plans, so it still
adds what changed since. `00006_planned_days` marks the dates that already hold a planned stayover.

**Events published** (payloads in `internal/housekeeping/events.go`):

- `housekeeping.room.state_changed.v1`: every board move, `{ unitId, villaId, locationId, from, to, on, by, note }`.
- `housekeeping.room.released.v1`: a unit turning ready: `{ unitId, unitCode, groupId, villaId, locationId, on, by, byId }`.
  Inventory's `command.Turnovers.Released` (consumer `inventory.housekeeping`) issues the room
  type's amenity kit as the mock's `stock.issueKit` does: what the store holds, reason
  "Amenity kit, SK-01 ready". The mock wrote a short store into the board note; that note is
  not written now, and the short part stays unissued.
- `housekeeping.linen.discarded.v1`: a discard from soiled or clean, or a batch's missing and
  damaged pieces: `{ discardId, villaId, locationId, from, lines: [{ itemId, quantity }], reason, batchId?, on, by, byId }`.
  `Turnovers.Discarded` books one `write_off` movement per line (quantity negative) with the
  event's reason. The pieces are gone already, so a short store books the write-off in full
  instead of refusing it as the mock's `writeOff` does. The batch lists `discardId` in
  `writeOffs`, and `POST /linen/discards` answers each line in the movement's shape with that id
  as its number; inventory numbers the movements it books (`SM-...`).
- `housekeeping.laundry.billed.v1`: the vendor's bill, which finance books as a cash-out submitted
  for approval (cashbox of the villa's location for cash, else the bank; the bank for a transfer):
  `{ batchId, number, villaId, locationId, vendor, amount, method, date, categoryId: "cat-house", origin: "maintenance", description, reference, attachments, by, byId }`.
  Finance answers with `finance.cash_out.decided.v1` as soon as it books the bill (status
  `submitted`) and on every decision after (consumer `housekeeping.cash-outs`), so the batch shows
  `transactionId` and `transactionStatus` from the moment the bill waits for approval.

**Not ported.** The day view, the phone list, linen levels and par coverage, and the housekeeping
reports: the console computes them from the reads.

## Messaging context (phase 4)

`internal/messaging` owns `GET`/`POST /messages`, `POST /messages/{id}/resend`, `GET`/`PUT
/messages/settings` and the public `GET /invoice/{token}`. Rules and wording come from
`src/domain/messaging.ts` and the mock's `messaging.ts`; the tests port
`src/application/messaging.test.ts` (the online check-in half belongs to reservation).

| Endpoint | Needs |
| --- | --- |
| `GET /messages` | booking/view; stays in the villa scope, plus city ledger invoices for finance/view. Reading first runs the sweep, as the mock's `messages()` does |
| `GET /messages/settings` | booking/view |
| `POST /messages`, resend, `PUT /messages/settings` | booking/edit; a resend of anything but a failed message is `MESSAGE_NOT_FAILED` |
| `GET /invoice/{token}` | public; an unknown or draft stay is `NOT_FOUND` |

**Templates and triggers.** `domain.DefaultTemplates` holds the eight templates in English and
Bahasa Indonesia; `domain.Render` fills `{guest}`, `{villa}`, `{unit}`, `{code}`, `{checkIn}`,
`{checkOut}`, `{link}`, `{amount}` (`Rp 1.500.000`), `{wifi}`, `{due}` and leaves unknown names as
typed. Indonesian guests get Bahasa Indonesia. A trigger sends once per stay and template, only
while the template is on:

| Trigger | Fires on |
| --- | --- |
| `booking_confirmed` | `reservation.booking.status_changed.v1` to confirmed, or a `booking.saved.v1` that creates a confirmed stay; not for a group's stay |
| `welcome`, `post_stay` | `status_changed` to checked_in, checked_out (post_stay carries the e-invoice link) |
| `pre_arrival`, `checkout_reminder` | the sweep: from `preArrivalDays` before arrival at 10:00, the evening before departure at 18:00 |
| `payment_link`, `payment_received` | billing's events below, every time (a link only when the desk sent it) |

**Provider.** `command.Provider` hands a message to a gateway. `provider.Simulated` (the default)
queues it and moves it to sent after a second and to delivered after five, as the mock does; the
sweep applies the move. `MESSAGING_PROVIDER=live` uses `provider.Live`: WhatsApp through Fonnte
(`FONNTE_TOKEN`) and email over SMTP; a gateway refusal fails the message with the gateway's reason,
so the desk can resend. The live call runs inside the queueing transaction, and delivery receipts
need a webhook route, which is not built; Qontak or the WhatsApp Cloud API plug in as another
`provider.Sender`.

**What messaging knows of other contexts.** Property events into `messaging.cat_*` (villa name,
unit code, room type name for `{unit}`), guest events into `messaging.guests` (name, phone, email,
nationality; a merge moves stays and messages to the kept profile), reservation booking events into
`messaging.stays` (with the e-invoice token), billing's payment links into `messaging.payment_links`.

**Billing events messaging consumes.** `billing.payment.recorded.v1` (billing publishes it) sends
`payment_received` with the payment's amount for a stay's payment (not a payout). Billing also
publishes its payment links (`billing.PaymentLinkSaved` in `internal/billing/events.go`; the part
messaging reads is in `internal/messaging/events.go`):

- `billing.payment_link.created.v1` `{ bookingId, villaId, locationId, date, link: { token, bookingId, paymentId, method, amount, gatewayFee, status, createdAt, expiresAt }, notify, orderIds, orderPaymentIds }`, version 1, for every link billing opens: messaging keeps the link and sends `payment_link` when `notify` is true, which billing sets only for a link the desk sent (`POST /payment-links`), as the mock's `createLink` does. Settle, group, check-in balance and room service QR links carry `notify: false`. `orderIds` lists the room service orders the link pays and `orderPaymentIds`, index for index, the pending payment carrying each (both empty for a link with no orders); services reads them.
- `billing.payment_link.updated.v1` (same payload), version 2, once a link leaves pending (paid, failed, cancelled, expired): keeps the link's status, so a `payment_link` sent by hand carries only a pending link.

**E-invoice.** `GET /invoice/{token}` finds the stay behind the token and asks `command.Billing` for
the invoice in the console's `InvoiceView` shape through `billing.Client.Invoice` (in process, or
`/internal/v1/billing/invoice` with `BILLING_URL`). Billing builds it as the payments service's
`invoice` does: the room, discount, Airbnb fee, charged service requests, delivered room service and
departure charges, the expected, paid and outstanding room money, the due date, payments, links,
room service totals and the tax note. `sourceLabel` and `account` come from billing's copy of the
Airbnb accounts, `roomType`, `place.group` and an unassigned stay's room line from its copy of the
room types, `group` (the booking group chip) from its copy of reservation's groups, `rate` is
`averageRate`, and the request lines come from its copy of services' requests (the billing section
lists the events). `guest` (the full profile) is left out: the link is public and the sheet prints
only `guestName`. `place` carries the ids and names of the villa, location and unit, which is what
the sheet prints. A
deployment without billing keeps `module.PendingBilling`, which answers `NOT_AVAILABLE` (503).

**Events published.** `messaging.message.saved.v1` `{ id, villaId, data }` for every message queued
or sent again. **Not ported here:** the city ledger invoice email (billing's
`city-ledger/invoices/{id}/send`) needs a messaging call or event that billing has to define; the
outbox already reads such messages (`cityLedger`, no villa) for finance.

**Seed.** `seed/messaging.json` holds the settings, the message history, the payment links and each
booking's villa; message stamps move to today, bodies keep the dates rendered at export.
`cmd/seed` loads housekeeping and messaging without their reactions (no check-out reaction, no
triggers), so the seed's own booking events do not send messages or move the board.
## Owners context (phase 2)

`internal/owners` owns the 16 endpoints in the ownership table, on the `owners` schema. Rules and
wording come from `src/domain/owner.ts`, the mock's `owners.ts` adapter and the allow() calls in
`src/application/owners.ts`.

| Endpoint | Needs |
| --- | --- |
| `GET /villa-owners`, `/management-contracts`, `/owner-statements`, `/owner-stays` | signed in; operator staff read the villas in their scope, a villa owner their own records and only approved statements |
| `POST`, `PATCH /villa-owners`, `/management-contracts` | finance/post |
| `POST /owner-statements` (close) | finance/post; months close in order (`STATEMENT_ORDER`), never the running month |
| `POST /owner-statements/{id}/approve` | finance/approve, then the Owner or an administrator (`APPROVAL_ROLE`), never the closer (`APPROVAL_SELF`) |
| `POST /owner-statements/{id}/pay`, `/reopen` | finance/post |
| `POST /owner-stays` | portal/create, the owner's own contract, the yearly allowance |
| `POST /owner-stays/{id}/decide` | booking/approve; approval picks a free unit of the villa |
| `GET /owner-portal/calendar?from&days` | portal/view: stays, owner stays and blocks on the owner's units, without guests |
| `GET /owner-portal/stays` | portal/view: every stay (dates, status, nightly rates, segment) and block on the owner's units, without guests or codes, for the portal's performance figures |

**Storage.** Each record keeps the console's JSON in `doc`; reads come from the write tables, so a save
reads back at once. One advisory lock serialises owners' commands. A reopened statement is deleted, so
its month reads as open, as in the mock. Each statement's payout (`payout_ref`, `payout_number`,
`payout_status`) sits beside its doc.

**What owners knows of other contexts.** Property events feed `owners.cat_locations`, `cat_villas`,
`cat_units` and `cat_blocks` (consumer `owners.catalog`): villa codes for statement numbers, units for
owner stays, owner blocks for owner nights. Channel's account events give Airbnb account names.
Reservation's booking events feed `owners.rm_stays` and its group events `owners.rm_groups` (consumer
`owners.stays`): the stub's room revenue, the portal calendar and figures (a stay in a corporate group
counts as corporate), and the free-night check on an owner stay. `rm_groups` came with migration
`00002_groups`, so on a database seeded before it the group events had already gone by; every start
catches it up from reservation (see "Catching up a late copy"). Finance's answers are in "Owners
events" below.

**The API works the figures out.** The console posts the draft it computed with the close; the API
checks that its lines add up (`STATEMENT_MISMATCH`) and closes with its own draft from
`owners.Results`. While finance is stubbed the API's figures hold room revenue and Airbnb fees only.

**The portal and operational reads.** A villa owner has no operational permission, so reservation's
reads (`GET /bookings`, `/booking-groups`, `/stay-restrictions`, `/overbooking-policies`, `/walks`,
`/pre-checkins`) refuse a portal-only role with `FORBIDDEN` ("A villa owner sees their villas in the
owner portal."). The console's portal pages read the owner port instead: the calendar
`GET /owner-portal/calendar` and the performance figures `GET /owner-portal/stays`, which the console
works into occupancy, ADR, RevPAR and room revenue as before.

**Owner stays.** Approval checks the unit (in the villa, active, no stay or block on those nights)
against owners' copies, picks the block id and publishes `owners.stay.decided.v1`; property's policy
(`command.AddOwnerBlock`) adds the block with that id and publishes `unit_block.added`, which every
copy projects. Read your writes holds the answer until property has the block.

**Not ported.** The cash account check on pay (finance refuses a payout from a non-bank account), the
ledger period lock on close and reopen (finance's), the room type availability check on an owner stay,
and the statement and payout reports, which the console builds from these reads.

## Files context (phase 2)

`internal/files` serves `POST /files`: the multipart field `file`, a photo or a PDF
(`image/jpeg`, `image/png`, `image/webp`, `image/heic`, `application/pdf`) of at most 5 MB, refused
with `ATTACHMENT_TYPE`, `ATTACHMENT_EMPTY` or `ATTACHMENT_SIZE` as `uploadProblem` words them. A part
sent without a type is sniffed. It answers `201` with the `Attachment` (`id`, `name`, `type`, `size`,
`url`, `uploadedBy`, `uploadedAt`); without a session the uploader is `Guest`, as in the mock, so a
guest can send a payment proof. `GET /files/{id}` serves the bytes to a signed-in user.

Files keeps no records and no schema: the context that attaches a file stores the `Attachment` on its
own record. The storage keeps each upload's `Attachment` as JSON beside the bytes (key `{id}.meta`,
never served by `GET /files/{id}`), so other contexts resolve files by id through `files.Client`
(`internal/files/client.go`): the module in process, `files.HTTPClient` to `FILES_URL`
(`GET /internal/v1/files?id=...`) in split mode. An unknown id answers `NOT_FOUND`; a file stored
before the JSON existed answers with its id as its name. Finance resolves `attachmentIds` on
`POST /transactions/{id}/attachments` and manual journals this way, and carries the files on billing's
`payment.recorded` and `payment.refunded` onto the cash entry (an unknown file, or a process without
files, books the entry without it). Without either client finance answers `NOT_AVAILABLE`. The bytes go through `storage.Storage`: `storage.Local` (a directory, the content type in a
`.type` file beside each object) or `storage.S3` (path-style PUT and GET signed with Signature Version
4, no SDK), chosen by `FILES_STORAGE`.

## Owners events

The owners context (phase 2) publishes these events and reads three from finance. Every payload is
JSON; amounts are whole rupiah. Payload types live in `internal/owners/events.go`.

**Published.**

| Event | Payload | Consumers |
| --- | --- | --- |
| `owners.villa_owner.saved.v1` | `{ owner }`, the `VillaOwner` | none yet |
| `owners.contract.saved.v1` | `{ contract, villaId, locationId }`, the `ManagementContract` | none yet |
| `owners.statement.closed.v1` | `{ statement, villaId, locationId, journal }`: the full `OwnerStatement` (figures, stays, entries, settlement) and the close journal | finance writes the journal |
| `owners.statement.approved.v1` | `{ statement, villaId, locationId }` | none yet |
| `owners.statement.reopened.v1` | `{ statement, villaId, locationId, reason, journal }`: the journal reverses the close entry | finance writes the reversal |
| `owners.payout.requested.v1` | `{ sourceRef, statementId, statementNumber, kind, accountId, categoryId, amount, date, villaId, locationId, description, reference, origin }` | finance creates the bank cash-out (or the top-up cash-in) and submits it |
| `owners.stay.requested.v1` | `{ request }`, the `OwnerStayRequest` | none yet |
| `owners.stay.decided.v1` | `{ request, villaId, locationId, block }`; `block` (`{ id, unitId, from, to, reason: "owner", note }`) is set when the stay is approved | property adds the owner block (consumer `property.owner-stays`) |

The close journal is `{ date, villaId, memo, source: "owner", sourceId, sourceNumber, origin: null,
lines: [{ accountId, debit, credit }] }`, dated the month end, as `ownerCloseJournal` in
`src/domain/journal.ts` writes it, zero lines left out:

| Line | Account | Amount |
| --- | --- | --- |
| Dr (Cr when negative) | `gl-5900` Owner share of villa results | GOP |
| Cr (Dr when negative) | `gl-4800` Management fee income | management fee |
| Cr | `gl-4900` Other income | owner stay charge |
| Cr | `gl-2510` FF&E reserve held for villa owners | reserve |
| Cr (Dr when negative) | `gl-2500` Payable to villa owners | net payable |
| Dr `gl-1220`, Cr `gl-2500` | Receivable from villa owners | a shortfall the owner tops up |

`kind` on a payout request is `cash_out` with `categoryId: "cat-owner-payout"` and the payable as the
amount, or `cash_in` with `categoryId: "cat-owner-topup"` and the shortfall when the contract has the
owner top up. `origin` is `owner_payout`, `reference` the statement number, `date` the business day.
`sourceRef` (`osp-...`) is new on every request, so a payout requested again after a rejection is a
new cash entry.

**Consumed from finance** (consumer `owners.finance`), each keyed by the `sourceRef` the payout
request carried:

| Event | Payload owners reads | Effect |
| --- | --- | --- |
| `finance.entry.approved.v1` | `{ transactionId, number, status, sourceRef }` | the statement records `payoutTransactionId`; the payout still waits |
| `finance.entry.posted.v1` | same | the payout is paid: the statement no longer reopens (`STATEMENT_PAID`) |
| `finance.entry.rejected.v1` | same | the payout is rejected: the statement may be paid again or reopened |

A seeded statement's payout has no `sourceRef`; owners matches those on `transactionId` instead. An
event that names no payout of a statement is ignored, so finance may publish these for every entry
it approves, posts or rejects. Until finance publishes them, a requested payout stays
`waiting`: `pay` again answers `PAYOUT_OPEN` and `reopen` answers `PAYOUT_OPEN`.

**Statement figures.** A statement needs the villa's results for the month: room revenue night by
night, Airbnb fees on arrivals, other income and expenses from the villa's posted entries, payroll
from the closed payroll, and the count of entries still waiting for approval. Owners asks for them
through `owners.Results.VillaResults(ctx, villaID, month)` (`internal/owners/results.go`), which
finance implements. Until finance does, `owners/adapters/results.Stub` answers in process from
owners' own copy of reservation's stays: room revenue and Airbnb fees as the villa P&L counts them,
no entries, zero payroll, nothing pending. Owner nights come from owners' copy of property's owner
blocks either way.
## Services context (phase 3)

Services owns the 23 endpoints in the ownership table: the room service menu per villa (hours,
notice, photo, price and partner cost), the service partners, orders from the desk and from the
guest's QR card, the order board, and the service requests board (towels, cleaning, repairs). Rules
and wording come from `serviceOrder.ts`, `roomService.ts`, the orders and service parts of
`services.ts` and the mock's `placeOrder`, `publicMenu` and order and request ports.

### Services events

Every payload is JSON in `internal/services/events.go`. Orders, menu items and requests carry the
record in the console's shape plus its villa and location, so a consumer builds its copy from one
event.

| Event | Payload | Consumers |
| --- | --- | --- |
| `services.order.placed.v1` | `OrderRecord` | read models, messaging |
| `services.order.status_changed.v1` | `OrderStatusChanged`: `OrderRecord` plus `from`, `to`, `note` | board copies, messaging |
| `services.order.delivered.v1` | `OrderBilled` | billing (folio lines), inventory (minibar stock out), finance (revenue and partner cost journal, partner bills) |
| `services.order.voided.v1` | `OrderBilled` with `reason` | billing reverses the lines, inventory puts the stock back, finance withdraws the partner bills and reverses the partner cost lines |
| `services.order.assigned.v1` | `OrderRecord` | board copies |
| `services.menu_item.saved.v1` | `MenuItemSaved`: `item` (MenuItem), `locationId` | inventory (minibar links), channel's site menu in split mode |
| `services.partner.saved.v1` | `PartnerSaved`: `partner` (ServicePartner) | finance (partner payables) |
| `services.request.saved.v1` | `RequestSaved`: `request` (ServiceRequest), `villaId`, `locationId` | billing (the e-invoice's charged requests); the seed publishes one per seeded request |

```json
// OrderRecord
{ "id": "so-15", "villaId": "vil-saka", "locationId": "loc-canggu", "bookingId": "bk-2104",
  "order": { "id": "so-15", "number": "SO-715", "status": "new", "lines": [...], ... } }

// OrderBilled (delivered.v1; voided.v1 adds "reason")
{ "orderId": "so-15", "number": "SO-715", "bookingId": "bk-2104", "unitId": "unit-sk-04",
  "villaId": "vil-saka", "locationId": "loc-canggu", "placedBy": "staff",
  "on": "2026-11-11", "at": 735,
  "lines": [
    { "itemId": "mi-sk-nasi-goreng", "name": "Nasi goreng ayam", "category": "food", "transactionCode": "FNB",
      "revenueCategoryId": "cat-svc-fnb", "unit": "item", "quantity": 2, "unitPrice": 75000, "amount": 150000,
      "comp": false, "partnerId": null, "unitCost": 0, "cost": 0 },
    { "itemId": "mi-sk-massage", "name": "Balinese massage, 60 minutes", "category": "spa", "transactionCode": "SPA",
      "revenueCategoryId": "cat-svc-spa", "unit": "person", "quantity": 2, "unitPrice": 300000, "amount": 600000,
      "comp": false, "partnerId": "ptn-taksu-spa", "unitCost": 180000, "cost": 360000 } ],
  "discountPct": 10, "discountReason": "Booked two treatments", "compReason": "",
  "totals": { "gross": 750000, "comp": 0, "discount": 75000, "charge": 675000, "cost": 360000, "margin": 315000 },
  "codes": [ { "code": "SPA", "amount": 540000 }, { "code": "FNB", "amount": 135000 } ],
  "revenue": [ { "categoryId": "cat-svc-spa", "amount": 540000 }, { "categoryId": "cat-svc-fnb", "amount": 135000 } ],
  "partnerCosts": [ { "partnerId": "ptn-taksu-spa", "partnerName": "Taksu Mobile Spa", "categoryId": "cat-svc-partner",
      "amount": 360000, "itemIds": ["mi-sk-massage"] } ] }
```

- `lines[].transactionCode` is `MENU_CATEGORY_CODE` (`FNB`, `MINI`, `LDRY`, `TRNS`, `SPA`, `TOUR`, `XTRA`);
  `codes` is `codeSplit`: the charge per code after comps and the discount, spread pro rata with the
  rounding on the biggest share. Billing posts one folio line per code with the order id; the guest
  pays `totals.charge`. Comped lines carry `comp: true` and count only in `totals.comp`.
- `revenue` is `revenueSplit`, the same charge per income category (`REVENUE_CATEGORY`).
- `partnerCosts` is `partnerCosts`: one bill per partner at cost (`cat-svc-partner`), owed even for
  comped lines. Finance books each as a submitted cash-out.
- Inventory takes the `minibar` lines (`category: "minibar"`) out of the villa store on delivered
  and puts them back on voided, through its own minibar links (menu item id to stock item).
- Delivered and voided also publish `status_changed`, so a consumer that only follows the board
  needs one event.

### What services knows of other contexts

| Need | Source |
| --- | --- |
| Villas, locations, units (menu villa, request unit, QR token per unit code, scope) | property events, projected into `services.cat_*` (consumer `services.catalog`) |
| The stay an order or request names, and the stays in a room for the QR card | `reservation.Stays` (`internal/reservation/stays.go`): the module's `StayLookup` in process, `StaysHTTP` to `RESERVATION_URL` (`/internal/v1/stays/booking/{id}`, `/stays/unit/{unitId}`) in split mode |
| The guest's first name on the QR page | `guest.Client` (`Guest`) |
| Payment state of an order, rebates, the open order link, the business date, the discount limit, order payment links | `command.Billing`: `bootstrap.servicesBilling` over `billing.Client` (`OrderPayments`, `BusinessDate`, `Policy`, `PayOrders`); `clients.PendingBilling` answers `NOT_AVAILABLE` in a deployment without billing |
| The partner bills of a delivered order and where each stands | `finance.cash_out.decided.v1` with `sourceType` `service_order` (consumer `services.finance`) into `services.partner_bills`, versioned by the entry's version; the seed loads the seeded bills' statuses from `partnerBills` in `seed/services.json`. Each answer rewrites the order's `costTransactionIds` in `partnerCosts` order, which the console's `rs-partners` report and partner balances read; a void is refused with `ORDER_VOID_PAID` ("A partner bill of SO-715 is already paid; post a rebate instead.") once a bill is posted |

With billing, payment states, rebates, the open order link and the business date come from billing,
and `POST /order/{token}/pay` returns billing's QRIS link for every delivered order still owed.
Services follows `billing.payment.recorded.v1` (consumer `services.billing`): each order in its
`orderIds` takes the payment as `paymentId` with a `paid` history step (`PAY-5360, QRIS`), as the
mock's `markOrdersPaid` does, so the board reads it paid; a refund or a redelivery changes nothing.
It also follows `billing.payment_link.created.v1` (same consumer): an open link points each order
in its `orderIds` at the pending payment in `orderPaymentIds`, with no history step, as the mock's
`openLink` does, so the board and the QR page read it pending until `payment.recorded` adds the
paid step. As in the mock the order keeps that payment when the link fails, expires or is
cancelled: billing moves the payment to that status, so the order reads unpaid and the guest's next
`/order/{token}/pay` opens a new link. `payment_link.updated.v1` therefore changes nothing on the
order and services does not subscribe to it. Without billing, an order that carries a `paymentId` (the seed's paid orders) reads as paid and
every other delivered order as unpaid; the void day is today; the discount limit is the default
10 %. `POST /order/{token}/pay` (the TypeScript `guestPay`, which opens a QRIS link through the
payment port) refuses `ORDER_NOT_BILLABLE` when nothing is owed and `NOT_AVAILABLE` otherwise
in a deployment without billing. The composition root passes `servicesBilling` through
`servicesmodule.Deps.Billing`. The console's `orders.pay`
calls billing's own `payments` and `payment-links` endpoints, not services.

### Permissions and storage

| Endpoint | Needs |
| --- | --- |
| `GET /menu-items`, `/service-orders`, `/service-requests` | signed in, scoped by the villa |
| `GET /service-partners` | signed in (partners belong to no villa) |
| `POST`, `PATCH /menu-items`, `/service-partners` | services/catalog (`Staff cannot edit the room service menu.`), villa in scope |
| `POST /service-orders` | services/create; comped lines also services/comp (`COMP_FORBIDDEN`), a discount past the limit booking/approve (`DISCOUNT_LIMIT`) |
| `PATCH /service-orders/{id}`, `POST .../{accept,prepare,deliver,cancel,void}` | services/edit, villa in scope |
| `POST /service-requests` | services/create; `PATCH` and `POST .../{start,done,cancel}` services/edit (the console checks nothing there) |
| `GET`, `POST /order/{token}`, `POST /order/{token}/pay` | no session; the QR token is the credential and the audit names `Guest` |

Each write row keeps the console's JSON in `doc` beside `villa_id` (and `booking_id`, `unit_id`)
with `version` for optimistic concurrency. Reads serve those tables directly, joined to
`services.cat_villas` for the location scope, so a saved order is on the board at once.
`services.counters` continues the mock's `seq()` (`SO-715`, `RQ-113`); menu items and partners take
`mi-<slug>-<tail>` and `ptn-<slug>-<tail>`. `PATCH /service-requests/{id}` tells the console's
three bodies apart: the full form (it carries `kind`), `{ assignee }` or `{ transactionId }`.

### Not ported yet

- Minibar stock leaves the store in inventory from the delivered event; delivery never refuses for
  a short store (`STOCK_SHORT` in the mock).
- `paymentId` on an order moves only through billing's payment links and `payment.recorded`; without billing, new orders never read as paid.
- Seeded orders publish no events: billing, inventory and finance seed their copy of that history
  from the same export.
- The board's late flags, delivery delays, totals and sorting are computed by the console from the
  order (`orderLate`, `deliveryDelay`, `sortOrders`); the domain ports them and their tests, the
  payload stays the console's `ServiceOrder`.
- A split channel reads the site menu from services' `/internal/v1/site-menu` (`services.SiteMenuHTTP`,
  `SERVICES_URL`); without it the site prints no menu.

## Billing context (phase 2)

Billing owns the 47 endpoints in the ownership table: the folio postings (charges, rebates, city
ledger transfers), guest payments, payment links and the public checkout at `/pay/{token}` with the
demo gateway, the payment policy, the night audit and the business date, cashier shifts, the city
ledger (accounts, billing on stays and groups, transfers, invoices with agent commission, payments,
credit, write-offs), the tax settings and the transaction codes. `ledger/tax-settings` and
`ledger/transaction-codes` sit under finance's `ledger` prefix; `scripts/ownership.mjs` gives them to
billing with a rule above finance's. Rules and wording come from `folio.ts`, `tax.ts`,
`transactionCode.ts`, `payment.ts`, `nightAudit.ts`, `cashier.ts`, `cityLedger.ts`, the master folio
of `group.ts`, and the mock's payment, folio, audit, cashier, city ledger and ledger adapters.

**The folio is a read model.** `domain.Folio` is `guestFolio` ported line for line: room nights with
their SVC and PB1 lines (forecast until the audit or check-out posts them), delivered room service per
code with items on the house and the discount, postings, the deposit memo, departure charges, payments
and refunds, the balance, the forecast, what is due per part of the bill and the refund due. Billing
builds it on demand from its copy of the booking, its payments and postings, the nights the audit
posted and the orders `command.Orders` returns. Tax follows `tax.ts` exactly, rates by posting date,
rounding half away from zero. `GET /bookings/{id}/folio` serves the postings, as the mock does; the
console computes the folio from them.

**Storage.** Each record keeps the console's JSON in `doc` with `booking_id`, `villa_id`,
`location_id` (the scope a read filters on) and `ref` (the key a rule looks up: the city ledger
account, the cashbox, the refunded payment). Reads come from these tables directly. Every money
command takes one transaction advisory lock (`billing.money`), so two payments never read the same
balance. `billing.counters` continues past the seed's numbers (`PAY-5359`, `fp-14`, `SH-0030`).

**What billing knows of other contexts.**

| Need | Source |
| --- | --- |
| Bookings and groups | reservation events into `billing.rm_stays` and `rm_groups` (consumer `billing.reservation`); a caller passes a stay it has not committed yet as JSON |
| Unit, villa and location names and scope | property events into `billing.cat_*` (consumer `billing.catalog`) |
| Late check-out charges | `reservation.late_checkout.granted.v1` (consumer `billing.late-checkout`), one LATE posting per stay keyed in `billing.late_checkouts` (see reservation's "Late check-out") |
| Guest names (payer, checkout page, invoices) | `guest.Client` through `clients.Guests` |
| Airbnb account of a stay (the invoice's source label and `account`) | channel's `airbnb_account.created` and `.updated` into `billing.cat_accounts` (consumer `billing.channel`) |
| Room type name (an unassigned stay's invoice line reads `Saka standard · room to be assigned`) | property's `unit_group.created` and `.updated` into `billing.cat_groups`, the unit's `groupId` on `billing.cat_units` (consumer `billing.catalog`) |
| Service requests (the invoice prints each charged one not cancelled as `Room service RQ-102`) | `services.request.saved.v1` into `billing.rm_requests` (consumer `billing.services`); services' seed publishes one per seeded request |
| The three rows above on a database seeded before `00003_invoice_names` | every start catches `cat_groups`, `cat_units.group_id`, `cat_accounts` and `rm_requests` up from property, channel and services (see "Catching up a late copy"); a unit row at the same version without a room type takes the replayed one |
| Room service orders | `services.order.delivered.v1` and `order.voided.v1` into `billing.rm_orders` (consumer `billing.services`), read through `postgres.Orders`; the folio posts each order's `codes` as services split them, with SVC and PB1 out of the menu price. Seeded orders publish no event, so `seed/billing.json` carries the delivered and voided ones |
| Cash accounts, approval status, closed months, a shift's cash | `command.Finance`; `clients.PendingFinance` until finance answers (see below) |
| The roster for opening a shift | `command.Roster` through `clients.Roster` over `people.Roster`: people's module in process, or `/internal/v1/people/rostered` with `PEOPLE_URL`. A billing process that reaches no people service reports nobody rostered, so only managers open shifts |
| Closing a stay whose check-out link the guest paid | reservation's check-out command in process, or `/internal/v1/stays/{id}/check-out` with `RESERVATION_URL` |

**Answers to reservation and services.** `billing.Client` (`internal/billing/client.go`): `Owed`,
`CheckOutHold` (`SETTLEMENT_PENDING`, `SERVICE_UNPAID`, `GROUP_MASTER_OPEN`, `FOLIO_UNSETTLED`),
`Settle`, `GroupPayment`, `PayBalance`, `CityLedger` (`CREDIT_LIMIT`, `CITY_LEDGER_CHANNEL`,
`CITY_LEDGER_INACTIVE`, `CITY_LEDGER_VILLA`), `Policy`, and for services `OrderPayments`, `BusinessDate` and `PayOrders`
(`ORDER_NOT_BILLABLE`). The monolith passes `module.Client()`; a split service gets
`billing.HTTPClient` to `/internal/v1/billing` (`BILLING_URL`), the principal in the body. In process
each answer joins the caller's transaction, so a settle and the check-out commit together.

**Facts for reservation.** Reservation keeps on its records what billing decides (consumer
`reservation.billing`): `stay.paidAmount` and `paymentStatus` from `payment.recorded`,
`payment.refunded` and `city_ledger.transferred`; `nightsPosted` from `night.audited`; and the
`cityLedger` billing of a booking or group from `billing.stay_billing.set.v1`
(`{ bookingId | groupId, billing }`). Billing publishes `billing.stay.checked_out.v1` when it sees
reservation's `booking.status_changed` to checked out, whichever path closed the stay.

**Permissions**, from the application services: folio charges, rebates, transfers and billing on stays
need booking/edit (rebates past the discount limit share of a line booking/approve,
`ALLOWANCE_LIMIT`); payments, links and shifts payments/create; refunds and the payment policy
payments/edit; the night audit booking/post and its list booking/view; shift lists finance/view or
payments/create, a sign-off a manager role or finance/approve; city ledger reads finance/view
(accounts: signed in, the booking form picks them), accounts finance/create or edit, invoices
finance/create, payments and write-offs finance/submit; tax settings and codes finance/edit. The
checkout page and the demo gateway are public. A refund pays back at most the credit in the payment's
part of the bill (`REFUND_EXCEEDS_CREDIT`) on a stay that is not cancelled; the cancellation terms
govern a cancelled one.

**Not ported.** The city ledger invoice email and the read
views the console computes: receivables aging, deposits held, Airbnb payouts against the bank, the
invoice list states and the audit checklist. Cash accounts, approvals and journals wait for finance.

**Known limits.** In split mode a settle and the check-out are two services and two transactions. A
paid check-out link closes the stay while billing holds its lock, and a concurrent settle-check-out on
the same stay locks the booking first; Postgres resolves the rare deadlock by failing one request.

## Billing to finance events

Billing owns the guest folio, guest payments and links, cashier shifts, the night audit, the city
ledger, the payment policy, the tax settings and the transaction codes. It writes no journal and no
cash entry. Each fact below goes out through the outbox as a versioned event with its full payload;
finance consumes them and books the cash entries, approvals and journals the TypeScript mock books
in `ledger.ts` and `newTransaction`. The Go types are in `internal/billing/events.go`.

Every payload carries `bookingId`, `villaId`, `locationId` (empty when the fact belongs to no stay,
such as a city ledger payment) and `date` (the business day, `YYYY-MM-DD`). Amounts are whole
rupiah. A **tax line** is `{ "code": "SVC" | "PB1", "account": "gl-2400" | "gl-2330", "amount": 100000 }`.
A **GL hint** (`account`) is the account of the line's transaction code (`codeAccount`): `gl-4100`
for ROOM, `gl-4210` for FNB and so on, `gl-4900` for an unknown code. Payment codes carry no
account; finance books them by the cash account the payment names.

| Event | Published when | Payload beyond the common fields |
| --- | --- | --- |
| `billing.folio_line.posted.v1` | a charge, a rebate or a city ledger transfer posts on a folio | `postingId`, `bookingCode`, `kind` (`charge`, `rebate`, `transfer`), `code`, `account`, `description`, `amount` (net), `service`, `pb1`, `gross`, `taxLines`, `part` (`room`, `orders`, `charges`), `lineId` (the line a rebate corrects), `orderId`, `approvedBy`, `postedBy`, `postedAt`, and `cityLedger` (`accountId`, `instruction`) on a transfer |
| `billing.folio_line.voided.v1` | services voids a delivery on its business day (`services.order.voided.v1`) | `orderId`, `orderNumber`, `bookingCode`, `reason`, `lines`: each folio line of the order with `lineId`, `code`, `account`, `amount` (net) and `taxLines` |
| `billing.payment.recorded.v1` | money comes in: a desk payment, a settle at check-out, a group share, a paid gateway link | `paymentId`, `number`, `bookingCode`, `unitId`, `kind` (`deposit`, `balance`, `full`, `extra`, `payout`), `method`, `code` (CASH, BANK, QRIS, VA, CARD, AIRBNB), `accountKind` (`cashbox`, `bank`, `gateway`), `cashAccountId` (the cashbox of the stay's location for cash, else the bank, as `accountFor` picks), `amount`, `fee` (the gateway fee, a `cat-fees` cash-out), `categoryId` (`cat-room`, `cat-airbnb`; room service splits by `revenue`), `revenue` (`categoryId`, `amount` per order category), `orderIds`, `orderAmounts`, `groupId`, `batch` (the shares of one batch land as one cash-in), `shiftId` (the cashier shift open at the stay's cashbox; empty for the guest and the gateway), `origin` (`front_desk` for cash, else `payment`), `reference`, `payer`, `attachmentIds`, `recordedBy`, `stay` (`paidAmount`, `paymentStatus` after it) |
| `billing.payment.refunded.v1` | money goes back on a payment | the payment fields of the refund (`kind` `refund`, cash for cash money and `bank_transfer` otherwise, `categoryId` `cat-other`) plus `refundOf`, `originalNumber`, `reason` |
| `billing.night.audited.v1` | the night audit closes a business date | `auditId`, `ranBy`, `ranAt`, `nextBusinessDate`, `noShows` (codes), `nights`, `roomRevenue`, `stays`: `bookingId`, `code`, `villaId`, `locationId`, `nights`, `nightsPosted` (every audited date of the stay), `lines` (`night`, `code` ROOM, `account`, `amount` net, `taxLines`) |
| `billing.stay.checked_out.v1` | a stay checks out: settle-check-out, a paid settle link or a plain check-out | `bookingCode`, `unitId`, `method` (how the charges were paid; cash by default), `cashAccountId`, `depositReturned`, `extraCharges` (departure charges, on DMG), `folioCharges` (charges less rebates taken at check-out), `chargePostingIds`, `roomLines` (nights no audit reached, posted at check-out, with `taxLines`), `balance`, `refundDue`, `taxes` (`subtotal`, `service`, `pb1`, `total`) |
| `billing.city_ledger.transferred.v1` | a stay's bill, or a master folio, moves to a company or agent account | `accountId`, `accountCode`, `bookingCode`, `instruction`, `code` (CL), `parts` (`postingId`, `part`, `orderId`, `amount` gross, `service`, `pb1`), `total`, `stay` (`paidAmount`, `paymentStatus`) |
| `billing.city_ledger.invoice_issued.v1` | an invoice is issued on an account | the `CityLedgerInvoice` as `invoice`, its figures beside it (`invoiceId`, `number`, `accountId`, `issuedOn`, `dueOn`, `lines`, `gross`, `service`, `pb1`, `commissionPct`, `commission`, `net`) plus `commissionAccount` (`gl-6750`, agent commission) and `receivableAccount` (`gl-1210`) |
| `billing.city_ledger.payment_received.v1` | an account pays | `paymentId`, `number`, `accountId`, `method`, `cashAccountId`, `amount`, `reference`, `note`, `allocations` (`invoiceId`, `amount`), `unapplied`, `categoryId` (`cat-city-ledger`), `origin`, `recordedBy` |
| `billing.city_ledger.written_off.v1` | a small balance is put up for write-off | `writeOffId`, `number`, `accountId`, `invoiceId`, `invoiceNumber`, `amount`, `reason`, `debitAccount` (`gl-6950`, bad debt), `creditAccount` (`gl-1210`), `createdBy` |
| `billing.tax_settings.changed.v1` | the tax settings are saved | `settings` (the whole `TaxSettings`: `rates` oldest first, `directMode`, `regencies`), `changedRates` (the rates added or replaced; null when only the mode or regencies changed), `savedBy` |

**What finance answers.** Where the mock creates a cash entry for approval (desk and gateway
payments, refunds, city ledger payments) or a manual journal (write-offs), billing publishes the fact
and finance creates the record, keyed by the payment, refund, city ledger payment or write-off id.
Billing reads its status back through `command.Finance` (in `internal/billing/app/command`):

| Method | Answers |
| --- | --- |
| `ApprovalStatus(ctx, ref)` | `submitted`, `approved`, `posted`, `rejected` or `reversed` for the entry finance made from the fact named `ref` |
| `AssertOpen(ctx, date)` | nil, or `PERIOD_CLOSED` when finance closed the month |
| `CashAccounts(ctx)` | the cash accounts (`id`, `name`, `kind`, `locationId`) payments and shifts land in |
| `ShiftCash(ctx, shiftID, accountID)` | cash in and out finance holds on a shift's cashbox |

In a billing process that reaches no finance service, `clients.PendingFinance` answers `submitted` for every reference (a city ledger
payment counts as pending on its invoices, never as paid), every month open, the cash accounts of
the demo seed (`seed/billing.json`), and a shift's cash from billing's own cash payments and refunds.

Billing also publishes `billing.stay_billing.set.v1`, `billing.cashier_shift.closed.v1`,
`billing.cashier_shift.dropped.v1` and `billing.transaction_code.saved.v1`; the billing section
describes them. `billing.payment_link.created.v1` and `billing.payment_link.updated.v1` are for
messaging; the messaging section describes them.

## Rules for later phases

1. Add a context as `internal/<name>/` with the same layers, its own schema and migrations, a
   `module` package, and an entry in `bootstrap.All`, `MigrationSets`, `Build` and `cmd/<name>`.
2. Port rules from the TS domain and mock adapter with the same codes and wording; validators return
   `errs.Fields` in the TS order. Port the matching TS tests.
3. Take paths and payloads from `src/infrastructure/http/index.ts` and `ports.ts`; keep `make contract`
   green for every context marked done. Add new prefixes to `deploy/gateway/Caddyfile`, specific
   paths above broad ones (`unit-groups/{id}/overbooking` belongs to reservation).
4. Every write runs in `db.InTx` and appends its events and audit line in that transaction. Never
   publish to the bus directly.
5. Serve reads from your own schema: a view or a projected `rm_*` table. Need another context's data?
   Project its events into your schema, or define a client interface and give it an in-process and
   an HTTP implementation.
6. Event handlers must be idempotent and order-tolerant (versioned upserts, tombstones); the inbox
   covers duplicates, the version column covers reordering.
7. Check permissions in command and query handlers with `rbac.Authorizer`, mirroring the `allow()`
   calls in `src/application/*.ts`, and enforce villa scope on reads and writes.
8. Done in phase 1: reservation replaced `property/adapters/stays.None` with its own stays answers,
   so `UNIT_IN_USE`, `ROOMS_TO_ASSIGN` and `BLOCK_OVERLAP` see stays, and consumes
   `property.unit_block.*` events for its own availability. It prices direct stays through
   `channel.Prices` and gives channel bookings, held nights and restrictions in process.

## Known limits

- Access tokens carry role and scope for up to 15 minutes after an administrator changes them.
- A poison event stops the relay at that row until it is fixed (order over progress).
- Split services cache the matrix for 10 seconds; with several replicas a permission change reaches
  each within that window.
- Idempotency keys are stored after the response, outside the write transaction.
- A payroll service without finance in its process reads a service charge pool of zero unless
  `FINANCE_URL` names the finance service; finance posts the close from `payroll.period.closed.v1`.
- Payroll's copy of an employee keeps the villa locations of its last event; a villa that moves
  location updates people's scope at once and payroll's on the employee's next save.
- Channel's catalog projection starts empty on a database where property's events were published
  before channel's migrations ran; `make seed` rebuilds it. Only the public `site` profile of
  villas and units is in `catchUps`; the rest needs property snapshots for locations, rate plans
  and blocks.
- The seed's `listing.created` events carry no villa or location: the projected units are not there
  while the seed runs. Commands after the seed carry both.
