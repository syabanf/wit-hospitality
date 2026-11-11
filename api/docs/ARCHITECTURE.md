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
    bootstrap/       composition root: builds contexts, picks clients and bus, router, seed
  deploy/gateway/    Caddyfile for split mode
  docs/              this file
  scripts/           node scripts: fixtures export, rbac snapshot, contract coverage, wiring check
  seed/              identity.json, property.json (exported from the TS seed builders)
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
| Processes | `cmd/monolith` | `cmd/identity`, `cmd/property`, `cmd/outbox-relay`, Caddy gateway |
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
  equal to the mock adapter's, access reads equal in shape and ids.

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
- Payroll close posts no bank cash-out or journal and the service charge pool reads zero until
  finance and billing consume `payroll.period.closed.v1` and replace `billing.NoPool` (see People
  and payroll).
- Payroll's copy of an employee keeps the villa locations of its last event; a villa that moves
  location updates people's scope at once and payroll's on the employee's next save.
