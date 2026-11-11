# Bali Villa Console API: architecture

The Go service in `api/` implements the `/api/v1` contract that `src/infrastructure/http/index.ts`
calls, with the rules and error codes the TypeScript mock adapter (`src/infrastructure/mock`)
enforces today. Point the console at it with `VITE_API_URL=http://localhost:8080/api/v1`.

Phase 0 builds the foundation, the **identity and access** context and the **property** context.
Later phases add one context at a time on the same foundation; the ownership table at the end says
which context owns each of the 303 adapter calls.

## Layout

```
api/
  cmd/
    monolith/        every context in one process, in-process bus
    identity/        identity alone (split mode, NATS)
    property/        property alone (split mode, NATS)
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
    maintenance/     work orders, expenses, assets, vendors, preventive plans; adapters/client/ (property holds)
    inventory/       items, villa stores, movements, receipts, counts, kits, minibar; adapters/stays/
    bootstrap/       composition root: builds contexts, picks clients and bus, router, seed
  deploy/gateway/    Caddyfile for split mode
  docs/              this file
  scripts/           node scripts: fixtures export, rbac snapshot, contract coverage, wiring check
  seed/              identity.json, property.json, maintenance.json, inventory.json (exported from the TS seed builders)
  openapi.yaml       served at /api/v1/docs/openapi.yaml
```

## Boundaries

1. A context lives under `internal/<context>/`. Its root package holds only `events.go`: the event
   names and payloads it publishes. That root package is the only part another context may import.
2. Contexts never import each other's subpackages and never join across schemas. Each context owns
   one Postgres schema (`identity`, `property`); the shared `platform` schema holds the outbox, the
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
  list right after a save, so this keeps the page consistent in both modes.
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
| any other business rule (`ACCESS_SELF`, `UNIT_IN_USE`, `ROOMS_TO_ASSIGN`, `BLOCK_OVERLAP`, `CONCURRENT_UPDATE`, ...) | 409 |
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
| Processes | `cmd/monolith` | `cmd/identity`, `cmd/property`, `cmd/maintenance`, `cmd/inventory`, `cmd/outbox-relay`, Caddy gateway |
| Unit holds for work orders | property in process, inside the work order's transaction | `PROPERTY_URL` `/internal/v1/unit-blocks/holds` and `/{id}/release` |
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
| `PROPERTY_URL` | | required by a maintenance service that does not run property |
| `MIGRATE_ON_START` | `false` | |
| `INITIAL_USER_PASSWORD` | `welcome123` | |
| `APP_ENV`, `APP_VERSION`, `LOG_LEVEL` | `development`, `dev`, `info` | |

## Seed data

`scripts/export-seed.mjs` loads `src/infrastructure/mock/state.ts` through Vite's SSR loader (the
repo has no tsx; Vite resolves the `@/` alias exactly as the app does), calls `buildState(baseDate)`
and writes the identity and property slices to `seed/identity.json` and `seed/property.json` with
that base date. `cmd/seed` embeds both files, shifts every date by today minus the base date, inserts
the write model, appends a created event per record and drains the outbox through the in-process
projector, so read models are built by the same code that serves commands. Rerun
`make export-fixtures` after the TypeScript seed changes.

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
make split-up           # identity, property, relay and the gateway on :8090
make test               # unit, integration (needs make db; skips without it), HTTP, rbac snapshot
make lint               # go vet and staticcheck
make contract           # implemented vs missing contract calls per context
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
- `scripts/wiring-check.mjs`: the console's own HTTP adapter against a running API, property reads
  equal to the mock adapter's, access reads equal in shape and ids. Maintenance and stock reads equal
  the mock's ignoring key order; a work order with a block and a submitted expense, `STOCK_SHORT`, a
  receipt, a refused correction and a count run on both and must agree.
- Maintenance and inventory: `stock.test.ts` ported case by case (the replay drift when an earlier
  receipt is cancelled, the corrected receipt average, day pricing, transfers), the maintenance
  rules, handler tests for corrections and cancellations after a rejection arrives from finance's
  event, block holds and releases through property, and HTTP tests for a work order with an
  expense, a `STOCK_SHORT` refusal, a receipt correction and a count.

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
| Bookings for a minibar check | reservation (not built) | `command.Stays`; `stays.None` answers NOT_FOUND until reservation supplies a client |
| Minibar menu items | services (not built) | `ref_menu_items`, seeded from the mock menu and kept by `services.menu_item.saved.v1` |
| Minibar sales | services (not built) | reacts to `services.order.delivered.v1` and `services.order.voided.v1` |

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

### Services and reservation gaps

- `POST bookings/{id}/minibar-checks` answers with the delivered order in the console's shape
  (`so-mb-N`, `SO-MN`), keeps it in `minibar_checks` and publishes
  `inventory.minibar_check.recorded.v1` for services to adopt and bill. Services must not publish
  `services.order.delivered.v1` for it: the restock already left the store.
- `services.order.delivered.v1` books the minibar lines out of the villa store in full: the order
  already reached the guest, so a short store goes below zero instead of refusing, and the next count
  puts it right. `services.order.voided.v1` puts the sold stock back at the cost it left at.
- Housekeeping (later) issues amenity kits and writes off linen through inventory; it will need a
  client with `IssueKit` and `WriteOff` over the same `Book` code.

### Events

Published: `maintenance.work_order.saved.v1` (state after every change), `maintenance.expense.*`,
`inventory.purchase.*`, `inventory.stock.moved.v1` (the movements one command booked),
`inventory.stock.low.v1` (a store just reached an item's reorder level),
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
8. Phase 1 (reservation) replaces `property/adapters/stays.None` with a real `command.Stays` client
   so `UNIT_IN_USE`, `ROOMS_TO_ASSIGN` and `BLOCK_OVERLAP` see stays; it consumes
   `property.unit_block.*` events for its own availability checks.

## Known limits

- Access tokens carry role and scope for up to 15 minutes after an administrator changes them.
- A poison event stops the relay at that row until it is fixed (order over progress).
- Split services cache the matrix for 10 seconds; with several replicas a permission change reaches
  each within that window.
- Idempotency keys are stored after the response, outside the write transaction.
