# Bali Villa Console API: architecture

The Go service in `api/` implements the `/api/v1` contract that `src/infrastructure/http/index.ts`
calls, with the rules and error codes the TypeScript mock adapter (`src/infrastructure/mock`)
enforces today. Point the console at it with `VITE_API_URL=http://localhost:8080/api/v1`.

Phase 0 builds the foundation, the **identity and access** context and the **property** context.
Phase 1 adds the **channel** context (Airbnb accounts and listings, the public site, web enquiries),
the **guest** context and the **reservation** context (bookings, groups, stay rules, walks, online
check-in).
Later phases add one context at a time on the same foundation; the ownership table at the end says
which context owns each of the 303 adapter calls.

## Layout

```
api/
  cmd/
    monolith/        every context in one process, in-process bus
    identity/        identity alone (split mode, NATS)
    property/        property alone (split mode, NATS)
    channel/         channel alone (split mode, NATS)
    guest/           guest alone (split mode, NATS)
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
    bootstrap/       composition root: builds contexts, picks clients and bus, router, seed
  deploy/gateway/    Caddyfile for split mode
  docs/              this file
  scripts/           node scripts: fixtures export, rbac snapshot, contract coverage, wiring check
  seed/              identity.json, property.json, channel.json, guest.json (exported from the TS seed builders)
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
  reusing a key for a different body is `IDEMPOTENCY_CONFLICT`. The console does not send it yet.
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
| Processes | `cmd/monolith` | `cmd/identity`, `cmd/property`, `cmd/channel`, `cmd/guest`, `cmd/reservation`, `cmd/outbox-relay`, Caddy gateway |
| Bus | in-process (`BUS=inproc`) | NATS JetStream (`BUS=nats`) |
| Relay | embedded (`OUTBOX_RELAY=embedded`) | `cmd/outbox-relay`; services set `OUTBOX_RELAY=off` |
| Session renewal and matrix in property | identity in process | `auth.HTTPRefresher` and `rbac.HTTPSource` (10 s cache) to identity's `/internal/v1`, guarded by `INTERNAL_TOKEN` |
| Entry | `:8080/api/v1` | gateway `:8090/api/v1`, routes by prefix (`deploy/gateway/Caddyfile`) |

Both modes share one Postgres instance today; each service touches only its schema and `platform`.

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
| `CHANNEL_URL` | | channel's base URL for services that read listing prices without running channel |
| `GUEST_URL` | | the guest service, for split services that call the guest client |
| `RESERVATION_URL` | | the reservation service, for a property service that asks about stays (`/internal/v1/stays`) |
| `MIGRATE_ON_START` | `false` | |
| `INITIAL_USER_PASSWORD` | `welcome123` | |
| `APP_ENV`, `APP_VERSION`, `LOG_LEVEL` | `development`, `dev`, `info` | |

## Seed data

`scripts/export-seed.mjs` loads `src/infrastructure/mock/state.ts` through Vite's SSR loader (the
repo has no tsx; Vite resolves the `@/` alias exactly as the app does), calls `buildState(baseDate)`
and writes the identity, property, channel, guest and reservation slices to `seed/*.json` with that
base date. Reservation loads after property's events are projected, since it reads villas from its
catalog copy; one-off restriction dates shift, yearly ones do not. Listing date prices move by the shift rounded to whole
weeks, so the seed's Friday and Saturday prices stay on those nights. `cmd/seed` embeds both files, shifts every date by today minus the base date, inserts
the write model, appends a created event per record and drains the outbox through the in-process
projector, so read models are built by the same code that serves commands. Rerun
`make export-fixtures` after the TypeScript seed changes.

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
- `scripts/wiring-check.mjs`: the console's own HTTP adapter against a running API, property and
  channel reads equal to the mock adapter's, access reads equal in shape and ids.

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
such records. Each owner's phase replaces one answer with a client; until reservation does,
`POST /enquiries/{id}/convert` refuses with `NOT_FOUND` for every booking.

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
| billing | 2 | 41 | 41 | Folio, guest payments and links, cashier shifts, city ledger, night audit |
| finance | 2 | 41 | 46 | Cash accounts, categories, transactions and approvals, reconciliation, general ledger, tax, budgets |
| owners | 2 | 14 | 14 | Villa owners, management contracts, owner statements, owner stays |
| services | 3 | 19 | 23 | Service requests, room service menu, partners and orders, guest ordering |
| maintenance | 3 | 18 | 18 | Work orders, assets, vendors, preventive plans |
| housekeeping | 3 | 20 | 20 | Room states and inspections, daily tasks, linen and laundry |
| inventory | 3 | 16 | 16 | Stock items, receipts, movements, counts, amenity kits, minibar |
| people | 4 | 24 | 30 | Employees, shifts and rosters, attendance, leave, overtime, loans, announcements, KPI reviews |
| payroll | 4 | 9 | 11 | Payroll settings and periods, payslips |
| messaging | 4 | 6 | 6 | Guest messages and settings, e-invoice links |
| files | 2 | 1 | 1 | Uploaded files and attachments |
| **total** | | **303** | **319** | |

Every endpoint, by owner:

- **identity**: `GET audit`, `POST auth/login`, `POST auth/logout`, `POST auth/password`, `GET auth/session`, `GET me`, `PUT me`, `GET permissions`, `PUT permissions/{}`, `GET users`, `POST users`, `PATCH users/{}`
- **property**: `GET locations`, `POST locations`, `PATCH locations/{}`, `POST properties`, `GET rate-plans`, `GET unit-blocks`, `POST unit-blocks`, `DELETE unit-blocks/{}`, `GET unit-groups`, `POST unit-groups`, `PATCH unit-groups/{}`, `PUT unit-groups/{}/rate-plan`, `GET units`, `POST units`, `PATCH units/{}`, `GET villas`, `POST villas`, `PATCH villas/{}`
- **channel**: `GET airbnb-accounts`, `POST airbnb-accounts`, `PATCH airbnb-accounts/{}`, `GET airbnb-listings`, `POST airbnb-listings`, `PATCH airbnb-listings/{}`, `PUT airbnb-listings/{}/prices`, `GET enquiries`, `POST enquiries/{}/convert`, `POST enquiries/{}/status`, `POST public/enquiries`, `GET public/site/holds`, `GET public/site/inventory`
- **reservation**: `GET booking-groups`, `POST booking-groups`, `POST booking-groups/{}/payments`, `POST booking-groups/{}/stays`, `DELETE booking-groups/{}/stays/{}`, `GET bookings`, `POST bookings`, `PATCH bookings/{}`, `POST bookings/{}/assign-unit`, `POST bookings/{}/cancel`, `POST bookings/{}/check-in`, `POST bookings/{}/check-out`, `POST bookings/{}/confirm`, `POST bookings/{}/move-unit`, `POST bookings/{}/no-show`, `PATCH bookings/{}/payment`, `POST bookings/{}/pre-checkin/verify`, `PUT bookings/{}/price`, `POST bookings/{}/settle-check-out`, `POST bookings/{}/walk`, `GET checkin/{}`, `PUT checkin/{}`, `POST checkin/{}/pay`, `GET overbooking-policies`, `GET pre-checkins`, `GET stay-restrictions`, `POST stay-restrictions`, `PUT stay-restrictions/{}`, `DELETE stay-restrictions/{}`, `POST stay-restrictions/bulk`, `PUT unit-groups/{}/overbooking`, `GET walks`
- **guest**: `POST bookings/{}/companions`, `GET foreign-reports`, `POST foreign-reports`, `GET guests`, `POST guests`, `PATCH guests/{}`, `DELETE guests/{}/blacklist`, `PUT guests/{}/blacklist`, `POST guests/{}/merge`, `GET lost-found`, `POST lost-found`, `PATCH lost-found/{}`, `POST lost-found/{}/move`, `GET lost-found/settings`, `PUT lost-found/settings`, `GET stay-companions`, `PATCH stay-companions/{}`, `DELETE stay-companions/{}`
- **billing**: `POST booking-groups/{}/city-ledger`, `PUT booking-groups/{}/city-ledger-billing`, `PUT bookings/{}/city-ledger-billing`, `GET bookings/{}/folio`, `POST bookings/{}/folio/charges`, `POST bookings/{}/folio/city-ledger`, `POST bookings/{}/folio/rebates`, `GET cashier-shifts`, `POST cashier-shifts`, `POST cashier-shifts/{}/close`, `POST cashier-shifts/{}/drop`, `POST cashier-shifts/{}/sign-off`, `GET cashier-shifts/hand-overs`, `GET cashier-shifts/policy`, `PUT cashier-shifts/policy`, `GET city-ledger/accounts`, `POST city-ledger/accounts`, `PATCH city-ledger/accounts/{}`, `POST city-ledger/accounts/{}/apply-credit`, `POST city-ledger/accounts/{}/invoices`, `GET city-ledger/invoices`, `POST city-ledger/invoices/{}/send`, `GET city-ledger/payments`, `POST city-ledger/payments`, `GET city-ledger/transfers`, `GET city-ledger/write-offs`, `POST city-ledger/write-offs`, `GET night-audits`, `POST night-audits`, `GET night-audits/business-date`, `GET pay/{}`, `POST pay/{}/proof`, `POST pay/{}/simulate`, `GET payment-links`, `POST payment-links`, `POST payment-links/{}/cancel`, `GET payments`, `POST payments`, `POST payments/{}/refund`, `GET payments/policy`, `PUT payments/policy`
- **finance**: `GET approval-rules`, `POST approval-rules`, `PATCH approval-rules/{}`, `DELETE approval-rules/{}`, `GET budgets`, `PUT budgets/{}/{}`, `GET cash-accounts`, `POST cash-accounts`, `PATCH cash-accounts/{}`, `GET categories`, `POST categories`, `PATCH categories/{}`, `GET ledger/accounts`, `GET ledger/category-accounts`, `PUT ledger/category-accounts/{}`, `GET ledger/journals`, `GET ledger/manual-journals`, `POST ledger/manual-journals`, `POST ledger/manual-journals/{}/approve`, `POST ledger/manual-journals/{}/post`, `POST ledger/manual-journals/{}/reject`, `POST ledger/manual-journals/{}/submit`, `GET ledger/periods`, `POST ledger/periods/{}/close`, `POST ledger/periods/{}/reopen`, `GET ledger/tax-settings`, `PUT ledger/tax-settings`, `GET ledger/transaction-codes`, `POST ledger/transaction-codes`, `PUT ledger/transaction-codes/{}`, `PATCH ledger/transaction-codes/{}`, `GET reconciliations`, `POST reconciliations`, `GET settings/proof-policy`, `PUT settings/proof-policy`, `GET transactions`, `POST transactions`, `POST transactions/{}/approve`, `POST transactions/{}/attachments`, `DELETE transactions/{}/attachments/{}`, `POST transactions/{}/post`, `POST transactions/{}/reject`, `POST transactions/{}/reverse`, `POST transactions/{}/submit`, `POST transactions/adjustments`, `POST transactions/transfers`
- **owners**: `GET management-contracts`, `POST management-contracts`, `PATCH management-contracts/{}`, `GET owner-statements`, `POST owner-statements`, `POST owner-statements/{}/approve`, `POST owner-statements/{}/pay`, `POST owner-statements/{}/reopen`, `GET owner-stays`, `POST owner-stays`, `POST owner-stays/{}/decide`, `GET villa-owners`, `POST villa-owners`, `PATCH villa-owners/{}`
- **services**: `GET menu-items`, `POST menu-items`, `PATCH menu-items/{}`, `GET order/{}`, `POST order/{}`, `POST order/{}/pay`, `GET service-orders`, `POST service-orders`, `PATCH service-orders/{}`, `POST service-orders/{}/accept`, `POST service-orders/{}/cancel`, `POST service-orders/{}/deliver`, `POST service-orders/{}/prepare`, `POST service-orders/{}/void`, `GET service-partners`, `POST service-partners`, `PATCH service-partners/{}`, `GET service-requests`, `POST service-requests`, `PATCH service-requests/{}`, `POST service-requests/{}/cancel`, `POST service-requests/{}/done`, `POST service-requests/{}/start`
- **maintenance**: `GET assets`, `POST assets`, `PATCH assets/{}`, `GET preventive-plans`, `POST preventive-plans`, `PATCH preventive-plans/{}`, `POST preventive-plans/generate`, `GET vendors`, `POST vendors`, `PATCH vendors/{}`, `GET work-orders`, `POST work-orders`, `PATCH work-orders/{}`, `PUT work-orders/{}/block`, `POST work-orders/{}/expenses`, `PUT work-orders/{}/expenses/{}`, `POST work-orders/{}/notes`, `POST work-orders/{}/status`
- **housekeeping**: `GET housekeeping`, `PUT housekeeping/{}`, `POST housekeeping/{}/inspections`, `GET housekeeping/settings`, `PUT housekeeping/settings`, `GET housekeeping/tasks`, `POST housekeeping/tasks`, `POST housekeeping/tasks/{}/{}`, `POST housekeeping/tasks/{}/issues`, `POST housekeeping/tasks/{}/lost-found`, `POST housekeeping/tasks/assign`, `POST housekeeping/tasks/auto-assign`, `POST housekeeping/tasks/plan`, `GET laundry/batches`, `POST laundry/batches`, `POST laundry/batches/{}/return`, `POST linen/discards`, `GET linen/pars`, `PUT linen/pars/{}`, `GET linen/soiled`
- **inventory**: `POST bookings/{}/minibar-checks`, `GET stock/counts`, `POST stock/counts`, `GET stock/items`, `POST stock/items`, `PATCH stock/items/{}`, `GET stock/kits`, `PUT stock/kits/{}`, `GET stock/minibar-links`, `PUT stock/minibar-links/{}`, `GET stock/movements`, `POST stock/movements`, `GET stock/receipts`, `POST stock/receipts`, `PUT stock/receipts/{}`, `POST stock/receipts/{}/cancel`
- **people**: `GET announcements`, `POST announcements`, `PATCH announcements/{}`, `DELETE announcements/{}`, `GET attendance`, `PUT attendance`, `GET employees`, `POST employees`, `PATCH employees/{}`, `GET kpi-reviews`, `POST kpi-reviews`, `PUT kpi-reviews/{}`, `GET leave-requests`, `POST leave-requests`, `POST leave-requests/{}/approve`, `POST leave-requests/{}/cancel`, `POST leave-requests/{}/reject`, `GET loans`, `POST loans`, `POST loans/{}/approve`, `POST loans/{}/cancel`, `POST loans/{}/reject`, `GET overtime-requests`, `POST overtime-requests`, `POST overtime-requests/{}/approve`, `POST overtime-requests/{}/cancel`, `POST overtime-requests/{}/reject`, `GET shift-assignments`, `PUT shift-assignments`, `GET shifts`
- **payroll**: `GET payroll/periods`, `POST payroll/periods`, `POST payroll/periods/{}/approve`, `POST payroll/periods/{}/calculate`, `POST payroll/periods/{}/close`, `POST payroll/periods/{}/lines/{}/adjustments`, `POST payroll/periods/{}/lines/{}/adjustments/{}/remove`, `POST payroll/periods/{}/publish`, `POST payroll/periods/{}/reopen`, `GET payroll/settings`, `PUT payroll/settings`
- **messaging**: `GET invoice/{}`, `GET messages`, `POST messages`, `POST messages/{}/resend`, `GET messages/settings`, `PUT messages/settings`
- **files**: `POST files`

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
| Blacklist (`GUEST_BLACKLISTED`) and check-in registration (`FOREIGN_DATA_MISSING`, `DOCUMENT_EXPIRED`) | `guest.Client`, through `clients.Guests` |
| Guest merges | `guest.merged.v1` (consumer `reservation.guest`) moves `guestId` and `leadGuestId` in the write and read models |
| Payment policy (discount limit, deposit, free cancellation days) and tax mode | the TypeScript defaults (`clients.DefaultSettings`) until billing and finance own them |
| Folio holds at check-out, room balance, payments, links, city ledger | `command.Billing`; billing is not built, so `clients.PendingBilling` answers `NOT_AVAILABLE` |

A guard whose context does not run passes (no folio, no listing, no guest record exists to refuse),
and work only that context can do answers `NOT_AVAILABLE` (503): a booking or group with
`newGuest`, a group deposit, `booking-groups/{id}/payments`, `settle-check-out`, `checkin/{token}/pay`
and a `cityLedger` billing on a new booking. Guest's client has no profile creation and no
pre-check-in copy yet, so `newGuest` refuses and a verified online check-in sets the stay's party
but leaves the profile and companions for guest.

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
`reservation.Site` through `bootstrap.siteSources`; in split mode channel keeps `sources.None` for
them until an HTTP client exists.

**Permissions.** The services check nothing before a lifecycle step, a move, new dates, notes or the
payment summary; the API asks booking/edit there. Create asks booking/create, groups booking/create
(and payments/create with a deposit), restrictions and overbooking property/edit, a walk and the
pre-check-in verify booking/edit, group payments payments/create. The check-in link is public.

**Not ported.** Presentation helpers the console computes from the reads (`lifecycleSteps`,
`nightState`, `occupancy`, `filterBookings`, `sortBookings`, `dayMarks`), the master folio and every
money movement (billing), the unregistered-adults note on check-in (guest's `Registration`), guest
messages on status changes (messaging) and the deposit, departure and relocation cash entries
(finance).

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
- Channel's catalog projection starts empty on a database where property's events were published
  before channel's migrations ran; `make seed` rebuilds it. A replay tool is not built yet.
- The seed's `listing.created` events carry no villa or location: the projected units are not there
  while the seed runs. Commands after the seed carry both.
