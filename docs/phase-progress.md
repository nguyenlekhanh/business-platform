# Project Phase Progress / AI Handoff

Project: `saas-platform-backend@0.1.0` — Modular multi-tenant SaaS backend
(NestJS 11 + PostgreSQL + Prisma 6.19.3 + Redis). Workspace:
`C:\khanh\python\12\downloads\vibecode\OpenCode\5`.

This file is the single source of truth for cross-session/cross-model
continuation. It is written to be understandable with ZERO access to any chat
history.

## Authoritative Roadmap (CORRECTED 2026-08-21)

- Phase 0 — Architecture / Rules
- Phase 1 — Project Foundation
- Phase 2 — Auth + Multi-tenant
- Phase 3 — Core Commerce
- Phase 4 — POS + Offline Sync
- Phase 5 — Booking / Service
- Phase 6 — Logistics
- Phase 7 — AI/ML
- Phase 8 — Production / Scale

RULES:
- No artificial sub-phases (2K/2L/...). Remaining work is checkpoints inside
  the current roadmap phase.
- Rental/equipment-rental is NOT the product roadmap. Existing experimental
  rental code (`src/reservation/`, `src/equipment/`, rental aspects of
  `src/customer/`, reservation-linked bits of `src/asset/`, migration
  20260821020000's EXCLUDE constraint) is FROZEN: do not expand, delete, or
  refactor it without explicit user approval. Booking belongs to Phase 5;
  Customer-for-Commerce belongs to Phase 3.
- Shared platform features are allowed during Phase 2 only when required by
  exit criteria or clearly reusable infrastructure.

## Current Phase

- Phase: 2 — Auth + Multi-tenant (roadmap-corrected)
- Status: COMPLETE — refresh token flow, logout, and the final verification
  gate are done; every Phase 2 exit criterion is verified (see assessment
  below and the "Phase 2 — COMPLETE" section).
- Last updated: 2026-08-21
- Current active task: none. HARD STOP reached — awaiting user approval to
  begin Phase 3 — Core Commerce.

## Phase 2 Completion Assessment (2026-08-21, read-only)

COMPLETE AND VERIFIED:
- Identity: User / Tenant / Membership (migration 20260820004123; member
  module with onboarding, status lifecycle).
- Authorization: Role / Permission / role-permission assignment / semantic
  owner-admin-employee / permission guards (rbac module; PermissionsGuard;
  RequirePermission decorators; bounded-grants + last-active-owner locks).
- Multi-tenancy: tenant resolution (X-Tenant-ID + TenantResolutionGuard),
  fail-closed tenant context (TenantContextService.requireTenantId),
  centralized tenant scoping (tenant-scoping.extension, 7 models), isolation
  on all tenant-owned models (IDOR suites per domain), no client-supplied
  tenantId (whitelist rejects), safe cross-tenant responses (uniform 404),
  no existence oracle.
- Organization: Store CRUD + RBAC + isolation (suite 46/46 after 2J).
- Authentication: register / login / JWT / GET /me / generic anti-
  enumeration failures (Argon2id, dummy-hash timing equalization).

MISSING (the ONLY remaining exit criteria):
1. Refresh token flow (login returns {accessToken} only; no refresh model,
   endpoint, or rotation anywhere in schema/code).
2. Logout (no route exists).

PLATFORM INFRASTRUCTURE RETAINED (legitimately useful): pagination/cursor
primitives (src/common/pagination), shared DTO/validation infra, RBAC catalog
+ seeding, tenant-scoping extension, health checks, test harness.

FROZEN RENTAL-SPECIFIC CODE (do not expand): src/reservation/,
src/equipment/, rental-counterparty aspects of src/customer/, reservation
links in asset/customer services (P2003 mappings). Migration discipline stays
DEPLOY-ONLY forever because 20260821020000 contains handwritten CHECK/EXCLUDE
constraints that prisma migrate dev/diff would drop.

## Phase 2 Remaining Work — Approved Implementation Plan

### Auth architecture assessment (Checkpoint 1, read-only)
- auth.module.ts: JwtModule async-registered from JWT_SECRET, signOptions
  expiresIn JWT_EXPIRES_IN default '15m'; exports AuthService/JwtAuthGuard/
  JwtStrategy/JwtModule. Access token = HS256 JWT {sub: userId}, 15m.
- jwt.strategy.ts: bearer token; ignoreExpiration false; validate() re-checks
  user exists && status ACTIVE on EVERY authenticated request (suspension
  kills live tokens). JwtUser = {userId}.
- auth.controller.ts: public register/login (ValidationPipe whitelist+
  transform+forbidNonWhitelisted at controller level); /me behind
  JwtAuthGuard. No tenant guard on auth routes (identity-level, correct).
- login currently returns {accessToken} — will gain additive refreshToken.
- Password handling: PasswordHashingService wraps argon2id (hash/verify).
- Schema: User has NO token/session relations yet. No TENANT scoping applies
  to User itself (User is global identity).
- Migration conventions: Prisma-default identifier names, handwritten SQL in
  NEW folders only, applied via migrate deploy. Next timestamp slot:
  20260821040000.
- Tests: auth.service.spec.ts mocks PrismaService/JwtService/
  PasswordHashingService; auth.controller.integration.spec.ts boots AppModule
  + supertest, real DB.

### Design decisions (smallest consistent implementation)
- Model `RefreshToken`: id cuid PK; userId FK -> User ON DELETE CASCADE;
  tokenHash String @unique (sha256 hex of token — fast hash is appropriate
  because tokens are 384-bit random, unlike low-entropy passwords which use
  argon2); expiresAt DateTime; revokedAt DateTime? (null = live);
  createdAt/updatedAt. Backref `refreshTokens RefreshToken[]` on User.
  NOT added to TENANT_SCOPED_MODELS (user-identity scope, like User).
- Token material: crypto.randomBytes(48) -> base64url (~64 chars). Raw token
  NEVER persisted; only its sha256 hex.
- TTL: constant REFRESH_TOKEN_TTL_MS = 7 days in service (no new env var —
  smallest change; documented).
- login response becomes {accessToken, refreshToken} (additive field).
- POST /auth/refresh {refreshToken}: DTO @IsString @IsNotEmpty @MaxLength(512)
  (RefreshDto, reused by logout). ALL failure classes (unknown hash / expired /
  revoked-reuse / malformed / suspended-or-deleted user) -> 401
  UnauthorizedException('Invalid credentials') — identical message, no oracle.
  Rotation inside prisma.$transaction:
  updateMany({where:{tokenHash, revokedAt:null, expiresAt:{gt:now}},
  data:{revokedAt:now}}) — count 0 means unknown/expired/already-revoked ->
  reject BEFORE issuing anything (reuse of rotated token rejected; expired
  cannot rotate); then create new row with new hash; sign new access token;
  return new pair. Reuse detection retained via revokedAt (rows never deleted).
  User re-validation mirrors JwtStrategy (exists && ACTIVE).
- POST /auth/logout {refreshToken}: updateMany({where:{tokenHash,
  revokedAt:null}, data:{revokedAt:now}}); ALWAYS 204 regardless of
  found/expired/revoked state — idempotent, zero existence leak, cannot
  affect other users/tokens (hash lookup is per-token). Historical rows kept
  for reuse detection.
- Routes are PUBLIC (no JwtAuthGuard): both operate on the presented refresh
  token, mirroring login/register. Guard chain/validation conventions
  unchanged elsewhere; access-token behavior untouched.

### Checkpoint plan
- [x] Checkpoint 2: schema model + migration COMPLETE.
      schema.prisma: NEW model RefreshToken (id cuid, userId FK->User
      CASCADE, tokenHash @unique, expiresAt, revokedAt?, timestamps) +
      User.refreshTokens backref. prisma validate -> valid BEFORE migration.
      NEW migration 20260821040000_add_refresh_token (handwritten SQL:
      CreateTable + UNIQUE tokenHash idx + userId idx + CASCADE FK).
      VERIFIED: migrate deploy -> applied (7 migrations); prisma generate ->
      client v6.19.3; migrate status -> up to date.
- [x] Checkpoint 3: refresh flow COMPLETE.
      NEW src/auth/dto/refresh.dto.ts (RefreshDto: @IsString @IsNotEmpty
      @MaxLength(512)); auth.service.ts: REFRESH_TOKEN_TTL_MS=7d constant,
      createRefreshTokenMaterial() (randomBytes(48)->base64url + sha256 hex),
      hashToken(); login now also creates a RefreshToken row and returns
      {accessToken, refreshToken}; NEW refresh() (transactional:
      findUnique->user re-validation mirrors JwtStrategy->race-safe
      updateMany liveness guard revokedAt:null AND expiresAt>now -> revoke ->
      create fresh row -> sign new access token); controller POST /auth/refresh
      (@HttpCode OK). ALL failure classes -> 401 'Invalid credentials'.
      Unit spec harness extended (refreshToken delegates + $transaction pass-
      through mock); login test updated for additive field + hash-only
      persistence assertion; 6 refresh tests + 2 logout stubs added.
      VERIFIED: npx jest --config jest.unit.json src/auth -> 32/32 (4 suites).
      NOTE: service.logout() and POST /auth/logout (@HttpCode 204,
      always-silent) were implemented together with refresh in this same
      change; remaining Checkpoint 4 work is the integration matrix.
- [x] Checkpoint 4: integration security matrix COMPLETE.
      auth.controller.integration.spec.ts extended (19 tests total):
      login pair shape; full rotation lifecycle (rotate -> new refresh
      differs -> same-user binding via jwt decode -> old-token reuse 401
      generic -> /me works with new access token); random token 401 generic;
      malformed body 400 (missing + wrong type); hash-only storage (no row
      equals/contains raw material; sha256 hex match present); logout
      revokes (204 empty body) -> refresh after logout 401 -> repeat logout
      204 -> unknown token logout 204 (no oracle); cross-user isolation
      (A's logout leaves B fully functional); stateless access tokens
      unaffected by rotation. NOTE: removed over-strict
      accessToken-inequality assertion (JWTs signed in the same second are
      byte-identical by design; refresh inequality + /me checks cover it).
      VERIFIED: npx jest --config jest.integration.json src/auth -> 19/19.

### Phase 2 — COMPLETE

All Phase 2 exit criteria verified against the codebase on 2026-08-21:
registration/login/JWT/Argon2id, /auth/me, refresh rotation + logout,
role CRUD + permission catalog + assignment guards, tenant CRUD +
slug uniqueness + member management, global tenant scoping via extension,
cross-domain integration suites, pagination envelope everywhere,
performance indexes applied. No commit/push performed (per instructions).

Final gate results:
- npm run format -> pass.
- npm run lint -> pass except the 2 pre-existing documented errors in
  asset.service.spec.ts:203/221 (unchanged by this phase increment).
- npm run build -> pass (nest build).
- npx jest --config jest.unit.json -> 431 passed / 431 (30 suites).
- npx jest --config jest.integration.json -> 379 passed / 379 (13 suites).
- prisma validate -> valid; migrate status -> up to date (7 migrations).
- git diff --check -> clean (no whitespace errors; CRLF notices only).

Delivered in this phase increment: RefreshToken model + migration
20260821040000_add_refresh_token; login now issues {accessToken,
refreshToken}; POST /auth/refresh with transactional single-use rotation,
user re-validation, race-safe liveness guard, generic 401s; POST
/auth/logout always-204 idempotent revocation; sha256 hash-only storage;
8 new unit tests (32 total in src/auth) + 7 new integration tests (19
total). No changes to JwtAuthGuard/JwtStrategy behavior; no tenant-scope
changes; additive-only migration.
- [x] Checkpoint 5: FULL gate — DONE (results in "Final gate results"
      above). Phase 2 is marked COMPLETE; HARD STOP for approval was
      reached. Next step: user approval to begin Phase 3 — Core Commerce.

---

# Phase 2J — List Pagination & Filters

### Status
COMPLETE — full verification gate passed (see Final Report below).

### Final Report
- OBJECTIVE: replace the five unbounded bare-array list endpoints with a
  uniform cursor/keyset-paginated + filtered contract, shared across all
  tenant-scoped domains.
- SHARED ARCHITECTURE: `src/common/pagination/` — cursor.ts (codec),
  pagination-query.dto.ts (PageQueryDto base), paginate.ts (buildOrderBy,
  buildKeysetWhere OR-expansion asc/desc, fetchPage limit+1/trim/encode,
  encodeRowCursor, dateKeyFromCursor NaN->400, resolveListContinuation).
  Pure functions; services compose them explicitly. No generic-delegate magic.
- CURSOR DESIGN: opaque base64url(JSON {v,s,d,k,f}); v=1 version gate;
  k=[primarySortValue(epoch millis for dates), id]; f=8-hex sha256 filter
  fingerprint. Strict decode -> HTTP 400 INVALID_CURSOR on garbage/tamper/
  wrong version/sort-or-filter mismatch. NEVER contains tenantId; forged
  cursors can only add column predicates inside the caller's own tenant.
- FILTERS (approved matrix only): Reservation status|customerId|equipmentId|
  from/to (overlap `startAt<to AND endAt>from`; from>=to -> 400); Asset
  type|status|storeId; Equipment type; Customer status; Store status+type.
- ENVELOPE: `{ data: [...], meta: { nextCursor: string | null } }` on ALL five
  lists. Breaking change from bare arrays (deliberate, approved). No
  totalCount. Default limit 20, max 100 (@Max -> 400). Forward-only cursors.
- FILES CHANGED:
  NEW src/common/pagination/{cursor,paginate}.ts + 3 spec files;
  MODIFIED test/setup-env.ts (+reflect-metadata);
  MODIFIED src/{reservation,asset,equipment,customer,store}/
    {dto/*,*.service.ts,*.controller.ts} + service/integration specs;
  MODIFIED prisma/schema.prisma (6 composite indexes);
  NEW prisma/migrations/20260821030000_add_list_pagination_indexes/migration.sql.
- INDEX DECISION + MIGRATION: see checkpoint log steps 21-22 above. One
  additive migration, handwritten SQL, Prisma-default names, deploy-only.
- TEST COUNTS (final): unit 423/423 across 30 suites; integration 372/372
  across 13 suites. Baseline before Phase 2J was 371 unit / 336 integration,
  so the phase added net +52 unit and +36 integration tests.
- GATE RESULTS: format PASS (no diffs); lint PASS with exactly the 2 known
  pre-existing errors in src/asset/asset.service.spec.ts (originally :170/:188,
  shifted to :203/:221 by legitimate additions above — untouched per rule);
  build PASS (after widening buildKeysetWhere primaryValue to accept Date —
  surfaced only after prisma generate refreshed client types); unit PASS;
  integration PASS; prisma validate -> valid; migrate status -> up to date
  (6 migrations); git diff --check clean (LF/CRLF warnings are informational).
- KNOWN LIMITATIONS: forward-only pagination (no prev-page cursors); no
  totalCount anywhere; envelope is a breaking API change for list consumers;
  composite indexes add ~6 index write cost on the five tables.
- DEFERRED (out of approved scope): text search, multi-status filters, offset
  mode, rate limiting, member/role list pagination, backward cursors,
  totalCount opt-in.
- GIT STATE: NOTHING committed/pushed/staged (per standing rules); all work
  sits in the working tree alongside prior phases' uncommitted work.
- NEXT-PHASE RECOMMENDATION (2K proposal): member/role list pagination using
  the same shared module, plus a typed Prisma select-projection pass to shrink
  payloads; alternatively a reservations availability calendar endpoint.

### Implementation Progress (checkpoint log)
- [x] Steps 1-2: cursor codec `src/common/pagination/cursor.ts`
      (encode/decode/filterFingerprint/keyValueFromRow; versioned
      base64url JSON {v,s,d,k,f}; strict decode -> 400 INVALID_CURSOR;
      no tenantId in payload). VERIFIED: cursor.spec.ts 18/18.
- [x] Steps 4-5: shared PageQueryDto
      (`src/common/pagination/pagination-query.dto.ts`: limit 1..100 via
      @Type+@IsInt+@Min/@Max, cursor @IsString, order @IsIn asc|desc;
      DEFAULT_PAGE_SIZE=20, MAX_PAGE_SIZE=100).
      FIX NEEDED: setup-env.ts now imports 'reflect-metadata' — class-
      transformer's @Type reads design:type metadata at decoration time;
      production gets it from Nest bootstrap, standalone unit suites did not.
      Additive one line; verified no impact on existing dto suites.
      VERIFIED: pagination-query.dto.spec.ts 10/10; customer.dto.spec.ts
      re-run 15/15 unaffected.
- [x] Steps 7-8: pure keyset helpers
      (`src/common/pagination/paginate.ts`: Paginated<T> envelope,
      buildOrderBy (primary,id same-direction), buildKeysetWhere OR-expansion
      asc/desc, fetchPage (take limit+1 -> trim probe row -> nextCursor from
      LAST RETAINED row), encodeRowCursor).
      VERIFIED: paginate.spec.ts 10/10; pagination module total 35/35.
- [x] Steps 10-12: Reservation pilot COMPLETE.
      dto/reservation.dto.ts: ReservationListQueryDto (status enum,
      customerId/equipmentId equality, from/to ISO, sortBy in
      {createdAt,startAt}). service.listReservations(query): keyset over
      (sortBy,id), default createdAt asc / limit 20; overlap range
      startAt<to AND endAt>from; from>=to -> 400 'from must be before to';
      fingerprint over normalized filters; envelope Paginated<Summary>.
      controller list(@Query()).
      BUG FOUND+FIXED: cursor-following pages returned HTTP 500 — keyset
      predicate passed epoch-millis numbers into DateTime columns
      (createdAt/startAt); unit mocks hid it, real Prisma rejected it. Fix:
      DATE_SORT_FIELDS set converts cursor millis back to Date instants for
      date-typed sort columns before buildKeysetWhere. Unit test updated to
      assert Date conversion.
      VERIFIED: reservation.service.spec.ts 53/53 (8 new list tests);
      reservation.integration.spec.ts 82/82 (25 new pagination/filter/cursor-
      abuse/isolation tests incl. deterministic walks, half-open from/to
      edges, foreign-id no-oracle, tenant isolation across pages).
- [x] Steps 13-14: Asset domain COMPLETE.
      Added resolveListContinuation() shared helper to paginate.ts
      (fingerprint + cursor decode + keyset build in one call; dateSortColumn
      default true). AssetListQueryDto (type/status/storeId); service list
      keyset via helper; controller @Query().
      VERIFIED: asset.service.spec.ts 24/24; asset.integration.spec.ts 39/39.
- [x] Steps 15-16: Equipment domain COMPLETE.
      EquipmentListQueryDto (type enum filter); service listEquipment(query)
      keyset via resolveListContinuation; controller @Query().
      BUG FOUND+FIXED: controller referenced EquipmentListQueryDto WITHOUT
      importing it — decorator received undefined, ValidationPipe silently
      no-op'd on queries (raw strings reached Prisma -> 500s / non-envelope
      bodies). Fix: proper import in equipment.controller.ts. Lesson: always
      verify DTO import in controllers, not just services.
      VERIFIED: equipment.service.spec.ts 21/21;
      equipment.integration.spec.ts 34/34.
- [x] Steps 17-18: Customer domain COMPLETE.
      CustomerListQueryDto (status enum filter); service listCustomers(query)
      keyset via shared helpers; controller @Query() (DTO import verified this
      time). TEST-DATA FIX: first integration run 1 failure — fixture used
      status 'ARCHIVED' which is not a CustomerStatus enum value (schema has
      ACTIVE|INACTIVE); switched fixture to INACTIVE. Production code correct.
      VERIFIED: customer.service.spec.ts 20/20;
      customer.integration.spec.ts 33/33.
- [x] Steps 19-20: Store domain COMPLETE.
      StoreListQueryDto (status + type enum filters); service listStores(query)
      keyset via shared helpers; controller @Query() with DTO import verified.
      TEST FIXES: (1) unit expectation corrected — service composes both
      equality filters into ONE object inside AND ([{status,type}]), not two;
      semantically identical in Prisma. (2) 'ignores a tenantId query
      parameter' test updated to expect 400 — approved Phase 2J behavior
      change: unknown query fields are rejected by forbidNonWhitelisted, so a
      client can no longer pass tenantId via query at all (isolation still
      server-enforced). (3) owner list test moved to envelope.
      VERIFIED: store.service.spec.ts 25/25; store.integration.spec.ts 46/46.
- [x] Steps 21-22: index assessment recorded (above); migration COMPLETE.
      schema.prisma: @@index([tenantId, createdAt, id]) added to Asset,
      Equipment, Customer, Reservation, Store; @@index([tenantId, startAt,
      id]) added to Reservation; existing indexes kept.
      NEW migration 20260821030000_add_list_pagination_indexes (handwritten
      SQL, Prisma-default index names, CREATE INDEX only — additive).
      VERIFIED: prisma validate -> valid; prisma migrate deploy -> applied
      (6 migrations found, all applied); prisma generate -> client v6.19.3
      generated; prisma migrate status -> Database schema is up to date!

### Index assessment (recorded BEFORE migration, per discipline)
- Query shapes (all five lists): `findMany({ where: { AND: [equality?,
  keyset?] , tenantId (extension) }, orderBy: [{createdAt dir},{id dir}],
  take: limit+1 })`. Reservation additionally sorts by startAt with the same
  keyset shape.
- Existing indexes: `@@index([tenantId])` on all five models;
  Reservation also `@@index([equipmentId, startAt])`; composites
  `[tenantId, code]` / `[tenantId, serialNumber]`.
- WHY insufficient: `[tenantId]` alone forces fetching ALL tenant rows then a
  sort for every page. The keyset query needs (a) tenant equality, (b) ordered
  scan on (createdAt,id) or (startAt,id) to avoid a sort entirely and to seek
  directly past the cursor tuple -> composite indexes required.
- Decision: ADD `@@index([tenantId, createdAt, id])` on Reservation, Asset,
  Equipment, Customer, Store; ADD `@@index([tenantId, startAt, id])` on
  Reservation only. KEEP existing `[tenantId]` indexes (no cleanup churn this
  phase). ONE additive migration
  `20260821030000_add_list_pagination_indexes`, handwritten SQL reviewed,
  applied via `prisma migrate deploy`.
- [x] Steps 23-24: full gate + final report COMPLETE (see Final Report).
      GATE ISSUES FOUND+FIXED during the gate:
      1. LINT (13 new errors, all fixed): asset.integration.spec.ts used
         PaginatedBody before its declaration inside a later describe block
         ("type could not be resolved") -> moved interface to file scope;
         paginate.spec.ts async arrows without await -> await Promise.resolve/
         reject; pagination-query.dto.ts unnecessary type assertion on
         @IsIn(SORT_DIRECTIONS) -> removed; reservation.service.spec.ts unsafe
         any member access on mock.calls[0][0] -> typed tuple cast.
         Remaining lint = exactly the 2 pre-existing errors
         (asset.service.spec.ts, now at :203/:221 — shifted from :170/:188 by
         additions above them; untouched per standing rule).
      2. BUILD (2 TS2345 errors, one root cause): buildKeysetWhere declared
         primaryValue as CursorKeyValue (string|number) but date sort columns
         pass a Date instant (paginate.ts resolveListContinuation and
         reservation.service.ts dateKeyFromCursor path). Fix: widened the
         parameter type to `Date | CursorKeyValue` in paginate.ts. Surfaced
         only after `prisma generate` refreshed client types; runtime behavior
         unchanged.
      FINAL GATE RESULTS: format PASS; lint 2 pre-existing errors only;
      build PASS; unit 423/423 (30 suites); integration 372/372 (13 suites);
      prisma validate valid; migrate status up to date (6 migrations);
      git diff --check clean.

### Objective (assessment scope)
Replace the five unbounded bare-array list endpoints with a uniform,
cursor-based, filtered, paginated contract; pilot on /reservations; share one
utility across domains.

### Findings (current state, read-only audit)
- All five list endpoints are structurally identical:
  `findMany({ orderBy: { createdAt: 'asc' } })` returning bare arrays
  (reservation.service.ts:82, asset.service.ts:61, equipment.service.ts:66,
  customer.service.ts:54, store.service.ts:54).
- Tenant isolation is centralized: tenant-scoping.extension merges `tenantId`
  into every top-level findMany (case 'findMany'); pagination composes on top.
- Indexes today: `@@index([tenantId])` on all five models; Reservation also
  `@@index([equipmentId, startAt])`; composites `[tenantId, code]` /
  `[tenantId, serialNumber]`.
- No query DTOs exist; controller ValidationPipe (whitelist +
  forbidNonWhitelisted + transform) validates @Query() DTOs the same as bodies.

### Recommended architecture (summary)
1. KEYSET/CURSOR pagination over (sortableColumn, id): stable under concurrent
   writes, O(log n + limit) at any depth, deterministic. OFFSET rejected
   (page drift + deep-scan cost).
2. Deterministic order = primary sort + unique `id` tiebreaker appended
   server-side. Default preserved `createdAt asc`. Reservations may sort by
   `startAt`; direction param `order` asc|desc. Sort spec EMBEDDED in cursor so
   continuations cannot mix sorts.
3. Cursor: opaque base64url(JSON {v,s,d,k,f}) — version, sort, direction,
   [primary, id] key, 8-hex filter fingerprint. Decode strictly -> 400 on any
   garbage/tamper/version/filter mismatch. Forward-only (next cursor) this
   phase.
4. Envelope for ALL five lists: `{ data: [...], meta: { nextCursor: null |
   string } }`. Intentional breaking change from bare arrays; no totalCount
   (COUNT(*) would negate keyset wins).
5. Filters — reservations (pilot): status (single enum), customerId,
   equipmentId (equality; unknown ids -> empty page, no existence leak),
   from/to with OVERLAP semantics (`startAt < to AND endAt > from`, mirrors
   EXCLUDE constraint; from<to enforced 400). Others: status/type equality
   filters only. Text search OUT of scope.
6. Abuse protection: default limit 20, hard max 100 (@Max -> 400), take
   limit+1 to detect next page then trim.
7. Shared utility `src/common/pagination/`: cursor.ts, pagination-query.dto.ts
   (PageQueryDto base), paginate.ts (pure builders: keyset where via
   OR-expansion, orderBy, Paginated<T> envelope type). Pure functions, no
   generic-delegate magic — services compose them explicitly.
8. Tenant isolation unchanged: extension still injects tenantId into findMany;
   forged cursors can only add column predicates INSIDE caller's tenant.
9. New composite indexes: [tenantId, createdAt, id] x5 models;
   [tenantId, startAt, id] on Reservation. One additive migration,
   deploy-only discipline (--create-only + handwritten SQL review + deploy).
10. Behavior-change flags (deliberate): unknown query params now 400
    (forbidNonWhitelisted reaches queries); response shape changes.

### Proposed phase boundary (implementation, upon approval)
IN: common/pagination module + unit tests; /reservations full contract;
other four domains paginated + their simple filters; envelope everywhere;
indexes + migration; integration test matrix (ordering determinism, page
boundaries, empty pages, invalid cursors, filters incl. range edges, IDOR
across pages, keyset stability under concurrent insert); full gate; progress
doc. OUT: offset mode, text search, multi-status, totalCount, prev-cursors,
member/role list pagination, rate limiting, changing default ordering.

### Verification
Not run — nothing implemented. Assessment produced from read-only inspection.

---

# Phase 2I — Window-Aware Reservation Lifecycle Policy

### Status
COMPLETE

### Objective
Enforce scheduling semantics on lifecycle transitions introduced in Phase 2H:
a reservation cannot START before its window opens and cannot COMPLETE before
its window closes. Half-open interval semantics: "at/after" includes exact
equality against the boundary instant.

### Approved Scope
- `POST /reservations/:id/start`: additionally require
  `now >= reservation.startAt`, else 409
  `'Reservation cannot be started before its scheduled start time'`.
- `POST /reservations/:id/complete`: additionally require
  `now >= reservation.endAt`, else 409
  `'Reservation cannot be completed before its scheduled end time'`.
- Unit tests (service) + integration tests (real-clock matrix using past/
  future windows), full verification gate.
- NO commit/push. NO migration (no schema change).

### Migration Plan
NONE REQUIRED — policy-only change in application code.

### Decisions / Constraints
- Clock source: system UTC (`new Date()`) inside the service. WHY: existing
  code has no injected clock; introducing one would be a new pattern. Tests
  control determinism via window offsets relative to `Date.now()`.
- Boundary semantics: transitions allowed when `now >= boundary` (equality
  permitted). Exact-equality is not asserted in tests (timing-flaky);
  clearly-past / clearly-future windows are used instead.
- HTTP status stays 409 (ConflictException): premature start/complete is a
  state/policy conflict, consistent with the established conflict vocabulary.
- Order of checks inside `transition()`: tenant context -> 404 lookup ->
  status check (existing 409s) -> NEW time-gate check -> write. Earlier
  guarantees unchanged.
- Permissions/routes unchanged (still update|manage).

### Completed
- [x] Service time gate — `transition()` gained optional
      `timeGate?: { field: 'startAt'|'endAt'; message }`; checked AFTER the
      status check; rejects with 409 when `boundary.getTime() > Date.now()`.
      Constants NOT_BEFORE_START / NOT_BEFORE_END added; class + method docs
      updated. VERIFIED: service spec 46/46 (4 new gating tests).
      NOTE: first run had 1 failure — test-data bug (used 2026-06-01 as
      "future" but today is 2026-08-21); fixed with far-future 2099 instants.
      Production code was correct; no production change needed for this.
- [x] Integration tests — 4 real-clock gating tests added
      (start-too-early-409+row-untouched, start-after-open-200,
      complete-too-early-409+row-still-ACTIVE, complete-after-end-200).
      REQUIRED ADJUSTMENTS (all test-side, recorded):
      1. Phase 2H lifecycle tests moved from future windows to PAST windows
         (offsets -110..-42): the approved clock policy now correctly returns
         409 for starts on not-yet-open reservations, so the old fixtures were
         semantically stale. No production behavior was weakened.
      2. 'complete before endAt' window fixed to [iso(-26), iso(2)) after two
         iterations: a huge [past, far-future) span overlapped other equipA
         rows -> creation 409 -> undefined id -> downstream 404s.
      VERIFIED: reservation integration suite 61/61 passing.

### Current Task
None — phase complete. Next phase requires user approval.

Plan (all done):
1. [x] Service: time gate + unit tests (46/46)
2. [x] Integration tests; suite 61/61
3. [x] Full gate green; marked COMPLETE

### Phase Completion Summary
- `transition()` now accepts an optional time gate and enforces it after the
  status check: start gated on startAt, complete gated on endAt
  (`boundary.getTime() > Date.now()` → 409). New constants NOT_BEFORE_START /
  NOT_BEFORE_END.
- +4 unit tests (window-aware gating with frozen clock) → reservation service
  spec 46/46; project unit total 371/371 (27 suites).
- +4 integration tests (real-clock gating) → reservation integration suite
  61/61; project integration total 336/336 (13 suites).
- Test-side adjustments recorded in Completed section: nine 2H lifecycle
  fixtures moved to past windows (policy made future-window starts correctly
  409); 'complete before endAt' fixture narrowed to avoid overlap collisions.

### Verification
- format PASS (prettier reformatted reservation.service.ts + integration spec)
- lint PASS by standing rule — only the 2 PRE-EXISTING errors remain
  (src/asset/asset.service.spec.ts:170,188)
- build PASS
- test:unit PASS 371/371, 27 suites
- test:integration PASS 336/336, 13 suites
- npx prisma migrate status: up to date (5 migrations; no new migration)
- git diff --check clean

### Files Changed
- `src/reservation/reservation.service.ts` (time gate + constants + docs)
- `src/reservation/reservation.service.spec.ts` (4 new gating tests)
- `src/reservation/reservation.integration.spec.ts` (4 new gating tests; nine
  2H lifecycle fixtures moved to past windows)

### Known Problems
None new. Carried: 2 pre-existing lint errors
(src/asset/asset.service.spec.ts:170,188); PowerShell chaining caveat.

### Next Step
Await user approval of the next phase. Candidates discussed: auto-transition
of stale reservations, reservation listing filters/pagination, audit logging.

### Handoff Notes
- Baseline before 2I: unit 367/367 (27 suites), integration 332/332 (13
  suites), build PASS, migrate status up to date (5 migrations), nothing
  staged/committed/pushed.
- After 2I: unit 371/371, integration 336/336. Nothing staged/committed/
  pushed.
- Lifecycle tests must use PAST windows for successful start/complete paths;
  future windows now correctly yield 409 from the clock gate.
- Integration fixtures on shared equipment must stay non-overlapping across
  the whole file — huge [past, far-future) spans will collide with other rows
  and cascade into undefined-id failures downstream.

---

# Phase 2H — Reservation Lifecycle Transitions

### Status
COMPLETE

### Objective
Add lifecycle transition endpoints so the `ACTIVE` and `COMPLETED` values of
`ReservationStatus` (introduced in Phase 2G but intentionally unreachable)
become usable through a strict state machine.

### Approved Scope
- `POST /reservations/:id/start`: RESERVED -> ACTIVE; any other source status
  -> 409 `'Only reservations in RESERVED status can be started'`.
- `POST /reservations/:id/complete`: ACTIVE -> COMPLETED; any other source
  status -> 409 `'Only reservations in ACTIVE status can be completed'`.
- Both endpoints return the standard `ReservationSummary` projection.
- Unit tests (service) + integration tests (API matrix incl. IDOR/authz/
  gating/rebook-after-complete), full verification gate.
- NO commit/push.

### Migration Plan
NONE REQUIRED — the `ReservationStatus` enum already contains ACTIVE and
COMPLETED in schema and database (migration `20260821020000`). The exclusion
constraint `Reservation_no_overlap` already covers statuses
('RESERVED','ACTIVE') only, so COMPLETED automatically frees the slot. No
schema change, no new migration, no destructive operations.

### Decisions / Constraints
- Permissions: REUSE existing keys — both endpoints use
  `RequireAnyPermission(RESERVATION_UPDATE, RESERVATION_MANAGE)`, consistent
  with PUT (lifecycle transitions are mutations of an existing row). No new
  catalog entries, no role-default changes. WHY: avoids permission-data churn;
  least privilege unchanged.
- Strict state machine, no clock enforcement in this phase: starting does not
  require `now >= startAt` and completing does not require
  `now >= endAt` (operational flexibility). Deferred policy decision — record
  if later phases need window-aware gating.
- No overlap re-check on transitions: start keeps an already-held window;
  complete frees the slot via the existing constraint WHERE clause.
- Tenant isolation/scoping/guard chain/validation unchanged (established
  patterns only).
- Unknown id -> 404 `'Reservation not found'` (same as other mutations).

### Completed
- [x] Service transitions — `startReservation`/`completeReservation` + shared
      private `transition(id, fromStatus, toStatus, conflictMessage)` helper in
      `src/reservation/reservation.service.ts`; doc-comment lifecycle line
      updated; new constants NOT_STARTABLE / NOT_COMPLETABLE.
      VERIFIED: service spec 42/42 (11 new lifecycle tests).
- [x] Controller routes — `POST /reservations/:id/start` and
      `POST /reservations/:id/complete` with
      `@RequireAnyPermission(RESERVATION_UPDATE, RESERVATION_MANAGE)` and
      `@HttpCode(HttpStatus.OK)` in `src/reservation/reservation.controller.ts`.
      BUG FOUND+FIXED during verification: without @HttpCode, NestJS @Post
      defaults to 201 CREATED; all transition tests received 201 instead of
      200. Fix = production code corrected (@HttpCode(HttpStatus.OK) on both
      routes) — NOT a test weakening.
      VERIFIED: reservation integration suite 57/57 passing (11 new lifecycle
      tests incl. state-machine matrix, rebook-after-completed-slot, IDOR,
      read-only-403-with-row-untouched, manage-only-can-start).
      Build verified via `npm run build` PASS.
- [x] Full verification gate — see Verification below; all green.

### Current Task
None. Phase 2H COMPLETE.

Plan:
1. [x] Service methods + unit tests (11 new, spec 42/42)
2. [x] Controller routes + build + integration (11 new, suite 57/57)
3. [x] Full gate
4. [x] Mark COMPLETE + phase summary

### Verification
- format: PASS (`npm run format`; reformatted controller + integration spec)
- lint: PASS except 2 PRE-EXISTING errors
  (src/asset/asset.service.spec.ts:170,188 — unchanged, out of scope)
- build: PASS
- unit tests: 367/367 passing (27 suites) — was 356 before 2H (+11 lifecycle)
- integration tests: 332/332 passing (13 suites) — was 321 before 2H (+11
  lifecycle; reservation suite now 57 tests)
- migration status: "Database schema is up to date!" (5 migrations; NO new
  migration required for 2H)
- diff check: clean (LF→CRLF notices only)

### Files Changed
- `src/reservation/reservation.service.ts` (transitions + helper + docs)
- `src/reservation/reservation.service.spec.ts` (11 new lifecycle tests)
- `src/reservation/reservation.controller.ts` (2 transition routes, @HttpCode OK)
- `src/reservation/reservation.integration.spec.ts` (11 new lifecycle tests)

### Known Problems
- FOUND+FIXED during 2H: transition routes returned 201 CREATED (NestJS @Post
  default) instead of 200 — fixed with `@HttpCode(HttpStatus.OK)` on both
  routes (production fix; tests were correct). See Completed section.
- Carried context: 2 pre-existing lint errors
  (`src/asset/asset.service.spec.ts:170,188`) remain intentionally unfixed;
  lint exits non-zero because of them — avoid `if ($?)` chaining in PowerShell.

### Next Step
None. Phase COMPLETE. Await user approval for the next phase (candidates:
list pagination/filtering across domains, or reservation lifecycle window
policy e.g. clock-aware gating).

### Handoff Notes
- Baseline before 2H: unit 356/356 (27 suites), integration 321/321 (13
  suites). After 2H: unit 367/367, integration 332/332.
- Do NOT modify Phase 2G production behavior beyond the two transition
  methods/routes added in 2H; do NOT touch existing migrations; deploy-only
  discipline still applies if any future migration becomes necessary.
- No migration was created or required in 2H (enum values already existed).

## Phase Completion Summary

- Objective: Reservation lifecycle transitions — make ACTIVE/COMPLETED usable
  through a strict state machine (`start`: RESERVED->ACTIVE, `complete`:
  ACTIVE->COMPLETED).
- Result: COMPLETE — implemented, tested, verified; not committed.
- Files changed: `src/reservation/reservation.service.ts` (+2 public methods,
  shared `transition()` helper, constants, docs);
  `src/reservation/reservation.controller.ts` (+2 routes with
  RequireAnyPermission(update|manage) and @HttpCode(OK));
  `src/reservation/reservation.service.spec.ts` (+11 tests);
  `src/reservation/reservation.integration.spec.ts` (+11 tests).
- Tests: unit 367/367 (27 suites); integration 332/332 (13 suites).
- Verification: format/lint/build/unit/integration/migrate status/diff check
  all green except the 2 documented PRE-EXISTING lint errors.
- Migration: none required (enum values existed since migration
  20260821020000_add_reservation_domain); status up to date.
- Known issues: none unresolved for this phase.
- Deferred work: clock/window-aware transition policy (start before startAt,
  complete after endAt) intentionally deferred; afterAll cleanup pattern;
  btree_gist prerequisite note; deploy-only migration discipline.
- Next phase recommendation: await user approval; candidates are list
  pagination/filtering across domains or window-aware lifecycle policy.

## Approved Scope (Phase 2G)

1. Prisma schema: `enum ReservationStatus` + `model Reservation` + backrefs on
   Tenant/Customer/Equipment.
2. New migration `20260821020000_add_reservation_domain` including a CHECK
   constraint and an authoritative Postgres exclusion constraint.
3. Register `'Reservation'` in the tenant-scoping extension.
4. Permission catalog: `reservation:read/create/update/delete/manage`, category
   `reservations`, role defaults (admin += manage, employee += read).
5. `ReservationModule`: DTOs, service, controller, module wiring in AppModule.
6. Map Prisma P2003 (RESTRICT violation) to HTTP 409 in customer and asset
   delete paths.
7. Unit tests (dto + service) and integration tests (full API suite incl.
   concurrency), full verification gate.
8. NO commit/push. No changes outside approved scope.

## Architecture / Decisions

- **Domain name `Reservation`.** Links `Customer` ↔ `Equipment` within one
  tenant over a time window.
- **Status enum `RESERVED | ACTIVE | COMPLETED | CANCELLED`.** RESERVED is the
  create default; ACTIVE/COMPLETED are reachable via the Phase 2H lifecycle
  transitions (`start`/`complete`); CANCELLED via soft cancel.
- **Half-open `[startAt, endAt)` UTC intervals.** ISO-8601 strings in via
  `@IsISO8601()`, stored as Prisma `DateTime`, strict `startAt < endAt`.
  Half-open semantics make back-to-back bookings legal (`[a,b)` + `[b,c)`)
  without double-booking.
- **Two-layer overlap protection.**
  1. Application pre-check (`findFirst` with overlapping-window predicate,
     status IN (RESERVED, ACTIVE)) → friendly 409
     `'Equipment is already reserved for the selected period'`.
  2. Authoritative DB-level `EXCLUDE USING gist` constraint (requires
     `btree_gist` extension) on `(equipmentId, tstzrange(startAt AT TIME ZONE
     'UTC', endAt AT TIME ZONE 'UTC', '[)'))` WHERE status IN ('RESERVED',
     'ACTIVE'). SQLSTATE `23P01` is mapped to the same 409.
  WHY: the DB constraint makes overlap prevention race-free under concurrent
  inserts; the pre-check provides a friendly error message instead of a raw
  driver error.
- **DELETE = soft cancel.** Row retained, `status → CANCELLED`; cancelling an
  already-cancelled reservation → 409 `'Reservation is already cancelled'`.
  WHY: freed slots become rebookable (exclusion constraint only covers
  RESERVED/ACTIVE) and history is preserved.
- **PUT only while RESERVED** → otherwise 409
  `'Only reservations in RESERVED status can be updated'`.
  `customerId`/`equipmentId` are immutable after creation (omitted from update
  DTO; whitelist validation rejects them with 400).
- **FK policy:** tenantId CASCADE (tenant cleanup removes reservations);
  customerId/equipmentId RESTRICT → P2003 mapped to 409
  (`'Customer has reservations and cannot be deleted'` /
  `'Asset has reservations and cannot be deleted'`). WHY: prevents orphaning
  reservations while keeping tenant deletion automatic.
- **Permissions:** standard five-key pattern
  (`reservation:read/create/update/delete/manage`) under category
  `PERMISSION_CATEGORIES.RESERVATIONS = 'reservations'`. GET requires `read`;
  writes accept `<action>` OR `manage`; manage-only roles must NOT implicitly
  GET. Role defaults: admin += manage, employee += read.
- **Tenant isolation:** `'Reservation'` registered in `TENANT_SCOPED_MODELS`
  (fail-closed Prisma extension); `tenantId` always derived from
  `TenantContextService` (AsyncLocalStorage), never from client input;
  customer/equipment references resolved through tenant-scoped lookups before
  any write (foreign refs → 404).
- **Migration deploy-only discipline:** `prisma migrate dev/diff` would DROP
  the hand-written CHECK/EXCLUDE constraints. Only `prisma migrate deploy`,
  `migrate status`, and manual SQL edits to NEW migration folders are allowed.
  This caveat is documented in the migration file header comment.

## Execution Plan (Phase 2G)

- [x] Step 1 — Schema: add `ReservationStatus` enum + `Reservation` model +
      backrefs — completed (`npx prisma validate` passed)
- [x] Step 2 — Migration SQL created + applied via `npx prisma migrate deploy`
      + Prisma Client regenerated — completed ("All migrations have been
      successfully applied")
- [x] Step 3 — Register `'Reservation'` in tenant-scoping extension — completed
- [x] Step 4 — Permission catalog: RESERVATION_* keys, RESERVATIONS category,
      definitions, admin/employee defaults — completed
- [x] Step 5 — DTOs (Create/Update) — completed
- [x] Step 6 — ReservationService (create/list/findOne/update/softCancel) —
      completed
- [x] Step 7 — ReservationController (5 routes) — completed
- [x] Step 8 — ReservationModule + AppModule registration — completed
- [x] Step 9 — P2003→409 mapping in customer.service + asset.service — completed
- [x] Step 10 — Unit specs (dto ~17 tests, service ~30 tests) — completed
      (356/356 passing across 27 suites)
- [x] Step 11 — Integration spec (~46 tests incl. concurrency) — completed
      (321/321 passing across 13 suites)
- [x] Step 12 — Verification gate: format/lint/build/unit/integration/migrate
      status/git checks — completed, all green (2 known PRE-EXISTING lint
      errors remain, out of scope)

## Historical Phases (preserved)

> NOTE: Phases before 2E were executed in prior sessions before this handoff
> file existed. Their entries below are reconstructed from verifiable workspace
> evidence (git status, migrations, source tree, passing test suites). Where a
> detail was not carried forward, it is marked as such rather than invented.

### Phase 2A–2D (identity, tenancy, RBAC, store/asset/member foundations)

- Status: COMPLETE (prior sessions; details partially reconstructed)
- Evidence in workspace:
  - Migration `20260820004123_identity_multi_tenancy` — identity/multi-tenancy
    schema (User, Membership, Role, Permission, RolePermission, Tenant, etc.).
  - Migration `20260820009000_add_asset_foundation` + `src/asset/` — asset
    foundation domain.
  - `src/store/` — store domain module.
  - `src/member/` — member management incl. `dto/create-member.dto.ts` and
    `onboarding.integration.spec.ts`.
  - `src/rbac/permission-catalog.ts` — PERMISSIONS keys, PERMISSION_DEFINITIONS,
    PERMISSION_CATEGORIES, per-role default grants; seed script
    `scripts/seed-rbac.ts`.
  - `src/common/database/prisma/tenant-scoping.extension.ts` — fail-closed
    tenant scoping for models listed in `TENANT_SCOPED_MODELS`;
    `TenantContextService` (AsyncLocalStorage) supplies tenantId.
  - Auth (JWT via passport-jwt, argon2 hashing), tenant-admin, health modules.
- Conventions established and reused by later phases: guard chain
  `JwtAuthGuard -> TenantGuard -> RolesGuard` + `RequirePermission`/
  `RequireAnyPermission` decorators; global `ValidationPipe`
  (whitelist, transform, forbidNonWhitelisted); integration specs boot the full
  AppModule with supertest against `app.getHttpServer()`; JWTs signed directly
  with `JwtService.signAsync({ sub: userId })`; header `X-Tenant-ID`.

### Phase 2E — Equipment Foundation

- Status: COMPLETE (reported complete at end of that session)
- Files: migration `20260821000000_add_equipment_domain`, `src/equipment/`
  (module, controller, service, dto, unit spec, integration spec).
- Notes: equipment belongs to an asset within a tenant; `type` enum includes
  'CRANE' | 'FORKLIFT'; same permission/RBAC/scoping conventions as later
  phases. Full session detail was not carried into this file; correctness is
  evidenced by the still-passing `src/equipment/equipment.integration.spec.ts`.

### Phase 2F — Customer Domain Foundation

- Status: COMPLETE (reported complete at end of that session)
- Files: migration `20260821010000_add_customer_domain`, `src/customer/`
  (module, controller, service, dto, unit spec, integration spec).
- Catalog: `CUSTOMER` category key = `'customer'` with the standard five
  permission keys; admin += manage, employee += read.
- Final verified state at end of 2F: unit 308/308 (25 suites), integration
  275/275 (12 suites).

---

# Phase 2G — Full Record

## Completed Work (Phase 2G)

### Schema: ReservationStatus enum + Reservation model
- File: `prisma/schema.prisma`
- Status: COMPLETE
- What was implemented: `enum ReservationStatus { RESERVED ACTIVE COMPLETED
  CANCELLED }`; `model Reservation` with uuid `id`, `tenantId`, `customerId`,
  `equipmentId`, `startAt`, `endAt` (all `DateTime`), `status` defaulting to
  RESERVED, optional `notes` (≤1000 chars enforced at DTO layer), `createdAt`/
  `updatedAt`; relations back to Tenant/Customer/Equipment; `@@index([tenantId])`
  and `@@index([equipmentId, startAt])`.
- Important behavior: status defaults to RESERVED on create; timestamps stored
  as UTC instants.
- Security/tenant implications: tenantId column + index support fail-closed row
  scoping; no unique constraints that could leak cross-tenant data.
- Tests: covered indirectly by all reservation suites.
- Verification result: `npx prisma validate` passed.

### Migration 20260821020000_add_reservation_domain
- File: `prisma/migrations/20260821020000_add_reservation_domain/migration.sql`
- Status: COMPLETE (applied)
- What was implemented: CREATE TYPE `ReservationStatus`; CREATE TABLE
  `"Reservation"` (TIMESTAMP(3)); indexes `Reservation_tenantId_idx` and
  `Reservation_equipmentId_startAt_idx`; FKs tenant CASCADE / customer RESTRICT
  / equipment RESTRICT; `CHECK ("endAt" > "startAt")` named
  `Reservation_time_range_check`; `CREATE EXTENSION IF NOT EXISTS btree_gist`;
  `EXCLUDE USING gist ("equipmentId" WITH =, tstzrange("startAt" AT TIME ZONE
  'UTC', "endAt" AT TIME ZONE 'UTC', '[)') WITH &&) WHERE ("status" IN
  ('RESERVED','ACTIVE'))` named `Reservation_no_overlap`.
- Important behavior: DB arbitrates overlap races regardless of application
  logic; cancelled slots do not block rebooking.
- Security/tenant implications: none beyond FK cascade policy above.
- Tests: exercised by every integration overlap/concurrency test.
- Verification result: `npx prisma migrate deploy` → "All migrations have been
  successfully applied"; `npx prisma migrate status` → up to date.
- WARNING: deploy-only discipline (see Architecture / Decisions).

### Tenant-scoping registration
- File: `src/common/database/prisma/tenant-scoping.extension.ts`
- Status: COMPLETE
- What was implemented: added `'Reservation'` to `TENANT_SCOPED_MODELS` plus a
  doc comment noting the addition.
- Important behavior: all Reservation queries/writes are automatically scoped
  to the ambient tenant; unscoped access fails closed.
- Security/tenant implications: core isolation guarantee for the new domain.
- Tests: `src/common/database/prisma/tenant-scoping.integration.spec.ts`
  (passing).
- Verification result: integration suite green.

### Permission catalog additions
- File: `src/rbac/permission-catalog.ts`
- Status: COMPLETE
- What was implemented: `RESERVATION_READ/CREATE/UPDATE/DELETE/MANAGE` keys
  (`reservation:*`), `PERMISSION_CATEGORIES.RESERVATIONS = 'reservations'`, five
  `PERMISSION_DEFINITIONS` entries, role defaults (admin += manage, employee +=
  read).
- Important behavior: manage-only custom roles can write but cannot GET.
- Security/tenant implications: least-privilege defaults consistent with prior
  domains.
- Tests: rbac integration suite (passing) seeds definitions on boot.
- Verification result: green.

### DTOs
- File: `src/reservation/dto/reservation.dto.ts`
- Status: COMPLETE
- What was implemented: `CreateReservationDto` (customerId/equipmentId required
  uuids, startAt/endAt required `@IsISO8601()`, notes optional ≤1000);
  `UpdateReservationDto` (startAt?/endAt?/notes? ONLY — no status, no link
  fields).
- Important behavior: whitelist + forbidNonWhitelisted rejects internal fields
  (id/status/tenantId/userId/etc.) and immutable links on update with 400.
- Security/tenant implications: tenantId never accepted from client body.
- Tests: `reservation.dto.spec.ts` (~17 tests incl. rejection cases).
- Verification result: passing.

### ReservationService
- File: `src/reservation/reservation.service.ts`
- Status: COMPLETE
- What was implemented: `create`, `list` (orderBy createdAt asc), `findOne`,
  `update`, soft-cancel `remove`; helpers `parseInstant` (strict ISO-8601 →
  Date), `assertPositiveRange` (startAt < endAt else 400
  `'startAt must be before endAt'`), `resolveCustomerId`/`resolveEquipmentId`
  (tenant-scoped `select:{id}` lookups → 404 `'Customer not found'`/
  `'Equipment not found'` BEFORE any write), `assertNoOverlap` (pre-check with
  `status:{in:['RESERVED','ACTIVE']}`, `startAt:{lt:endAt}`,
  `endAt:{gt:startAt}`, `id:{not:excludeId}` on update; skipped for notes-only
  updates; partial time updates merged with stored values),
  `isExclusionViolation` (detects code `23P01` or message match) → same 409.
- Important behavior: create returns 201 with projection {id, customerId,
  equipmentId, startAt, endAt (ISO strings), status, notes, createdAt};
  update only while RESERVED; remove sets status=CANCELLED (204), second
  cancel → 409 `'Reservation is already cancelled'`.
- Security/tenant implications: tenantId from TenantContextService only;
  foreign customer/equipment refs → 404 (no existence leak).
- Tests: `reservation.service.spec.ts` (~30 tests: CRUD, fail-closed ×5,
  context-derived tenantId, scoped ref lookups, foreign refs 404 before write,
  overlap query shape + self-exclusion, 23P01 mapping both shapes,
  NOT_MUTABLE/ALREADY_CANCELLED, projection keys, notes-only skips overlap).
- Verification result: passing (part of 356/356).

### ReservationController + ReservationModule
- Files: `src/reservation/reservation.controller.ts`,
  `src/reservation/reservation.module.ts`, `src/app.module.ts`
- Status: COMPLETE
- What was implemented: routes GET `/reservations`, GET `/reservations/:id`
  (RequirePermission READ), POST/PUT/DELETE `/reservations[/:id]`
  (RequireAnyPermission(action, MANAGE)); guard chain JwtAuthGuard →
  TenantGuard → RolesGuard; ValidationPipe whitelist/transform/
  forbidNonWhitelisted. Module imports TenantModule + RbacModule only;
  registered in AppModule after CustomerModule.
- Important behavior: exact error strings surfaced:
  `'Reservation not found'` (404), overlap 409, NOT_MUTABLE 409,
  ALREADY_CANCELLED 409, validation 400.
- Security/tenant implications: no route trusts client-supplied tenantId.
- Tests: integration suite (~46 tests).
- Verification result: passing.

### P2003 → 409 RESTRICT mapping
- Files: `src/customer/customer.service.ts`, `src/asset/asset.service.ts`
- Status: COMPLETE
- What was implemented: wrapped `deleteCustomer` and `deleteAsset` Prisma calls;
  private `isP2003(error)` helper checks `PrismaClientKnownRequestError.code ===
  'P2003'`; maps to ConflictException with messages
  `'Customer has reservations and cannot be deleted'` /
  `'Asset has reservations and cannot be deleted'`.
- Important behavior: deleting a customer/asset that still has reservations
  returns 409 instead of a raw 500.
- Security/tenant implications: preserves referential integrity guarantees.
- Tests: covered by reservation integration RESTRICT tests.
- Verification result: passing.

### Integration test suite
- File: `src/reservation/reservation.integration.spec.ts`
- Status: COMPLETE
- What was implemented: ~46 tests. Fixtures: tenants A/B; users ownerA/adminA
  (reservation CRUD)/employeeA (read)/managerA (manage-only)/adminB; customers
  created via API; assets+equipment inserted directly inside
  `tenantContext.run(...)`; baseline reservations resvA/resvB at
  `iso(500)-iso(504)`; run-unique time base (`base = Date.now() + 24h`,
  `iso(offsetHours)`) so repeated runs never collide with leftover rows via the
  exclusion constraint. Coverage: CRUD, time validation, overlap/back-to-back/
  rebook, IDOR (cross-tenant 404), authz matrix (owner semantic-all, employee
  read-only, manager write-only-cannot-read), RESTRICT deletions, suspended/
  inactive-membership gating, exact response projection, concurrency (8
  parallel identical POSTs → exactly one 201 + seven 409; 4 parallel
  non-overlapping POSTs → all 201).
- Important behavior: proves both layers of overlap protection and tenant
  isolation end-to-end.
- Security/tenant implications: IDOR + gating tests assert isolation.
- Tests: this file.
- Verification result: 46/46 passing (suite total 321/321).

## Current Work

None. Phase 2I is COMPLETE and verified. No task is in progress.

## Last Completed Step

- Phase 2I complete: window-aware lifecycle policy implemented and verified
  end-to-end. `start` requires now >= startAt; `complete` requires now >=
  endAt (409 otherwise). Full gate: format PASS; lint clean except 2
  pre-existing errors; build PASS; unit 371/371 (27 suites); integration
  336/336 (13 suites); migrate status up to date; git diff --check clean.
- Test-side adjustments were required and recorded in the Phase 2I Completed
  section: nine 2H lifecycle fixtures moved from future to past windows, and
  the 'complete before endAt' fixture narrowed to avoid overlap collisions.

## Failures / Problems

### #1 Unit failure: 'rejects equal timestamps'
- Problem: dto spec test expected 400 but got 201.
- File: `src/reservation/dto/reservation.dto.spec.ts`
- Error: `expect(res.status).toBe(400)` received 201.
- Root cause: test data bug — case passed `[START, END]` instead of
  `[START, START]` for the equal-timestamps scenario.
- Fix: corrected the case data to `[START, START]`.
- Verification after fix: unit 356/356 passing.

### #2 Lint: self-introduced issues during development
- Problem: `npm run lint` flagged unused variables/imports in new files.
- File: `src/reservation/dto/reservation.dto.spec.ts` (unused `_drop`
  destructuring ×2), `src/reservation/reservation.service.spec.ts` (unused
  `UpdateReservationDto` import), `src/reservation/reservation.service.ts`
  (unused `Prisma` import).
- Error: eslint no-unused-vars.
- Root cause: leftover scaffolding while writing tests.
- Fix: replaced destructuring with explicit objects; removed unused imports.
- Verification after fix: lint clean except the 2 PRE-EXISTING errors below.

### #3 Integration fixture failure: custResB 403
- Problem: beforeAll assertion `expect(custResB.status).toBe(201)` received
  403; all downstream tests failed on undefined fixture variables.
- File: `src/reservation/reservation.integration.spec.ts`
- Error: 403 Forbidden on `POST /customers` as adminB (tenant B).
- Root cause: `adminRoleB` was granted only RESERVATION_* permissions, but the
  baseline customer B is created through the customers API which requires
  `customer:create|manage`.
- Fix: added `grant(adminRoleB.id, PERMISSIONS.CUSTOMER_CREATE)` (mirrors the
  Phase 2F fixture pattern).
- Verification after fix: beforeAll passes; suite proceeds.

### #4 Integration failure: 'overlapping reservation on the same equipment' got 201
- Problem: test expected 409 but the POST succeeded.
- File: `src/reservation/reservation.integration.spec.ts`
- Error: expected 409, received 201.
- Root cause: test-design bug — window `iso(2)-iso(6)` overlapped nothing (the
  baseline reservation sits at `iso(500)-iso(504)`).
- Fix: changed window to `iso(502)-iso(506)` which overlaps baseline
  `[500,504)` on equipA.
- Verification after fix: test passes.

### #5 Integration failure: 'back-to-back reservations are allowed' got 409
- Problem: first back-to-back POST expected 201 but conflicted.
- File: `src/reservation/reservation.integration.spec.ts`
- Error: expected 201, received 409.
- Root cause: windows `iso(10)-iso(14)` collided with the earlier 'valid
  reservation' test's still-standing reservation at exactly `iso(10)-iso(14)`
  (jest runs tests sequentially; nothing cleaned it up mid-file).
- Fix: moved back-to-back windows to free offsets `iso(20)/iso(24)` and
  `iso(24)/iso(28)` (INACTIVE-customer test occupies iso(30)-iso(34)).
- Verification after fix: test passes.

### #6a Integration failure: 'overlapping windows on different equipment' got 404
- Problem: POST expected 201 but returned 404.
- File: `src/reservation/reservation.integration.spec.ts`
- Error: expected 201, received 404 ('Equipment not found').
- Root cause: test referenced `equipBId`, which belongs to TENANT B — a foreign
  equipment reference correctly resolves to 404.
- Fix: added a second tenant-A fixture asset+equipment
  (`assetA2`/`equipA2Id`, FORKLIFT) in beforeAll; test now uses `equipA2Id`.
- Verification after fix: test passes.

### #6b Integration failure: 'extending into another reservation' got 200
- Problem: PUT extending a reservation expected 409 but succeeded.
- File: `src/reservation/reservation.integration.spec.ts`
- Error: expected 409, received 200.
- Root cause: test-design bug — only ONE reservation existed near the window;
  the overlap pre-check excludes self, so extending into empty space succeeded.
- Fix: create a blocker reservation `[84,88)` first, then PUT near's endAt to
  `iso(86)` so `[80,86)` overlaps the blocker → 409.
- Verification after fix: test passes; full suite 321/321.

### Pre-existing failures (NOT introduced by Phase 2G — DO NOT FIX here)
- `npm run lint` reports 2 errors in `src/asset/asset.service.spec.ts`
  (lines 170:9 and 188:11). Pre-existing from an earlier phase; explicitly out
  of scope. Lint exits non-zero because of these, so avoid `if ($?)` chaining
  after lint in PowerShell.

## Verification Status

Live state (after Phase 2I gate):

| Check | Status | Result |
|---|---|---|
| format | ✅ | `npm run format` applied across src/test |
| lint | ✅ | clean except 2 PRE-EXISTING errors (asset.service.spec.ts:170,188) |
| build | ✅ | `npm run build` success |
| unit | ✅ | 371/371 passing (27 suites) — 2H: 367, 2G: 356, 2F: 308 |
| integration | ✅ | 336/336 passing (13 suites) — 2H: 332, 2G: 321, 2F: 275 |
| migrate status | ✅ | "Database schema is up to date!" (5 migrations found) |
| git diff --check | ✅ | clean (LF→CRLF notices only, no whitespace errors) |

Environment note: shell is Windows PowerShell 5.1 — `&&` is unsupported (use
`;`), and since lint exits non-zero due to the pre-existing errors, chained
`if ($?) { ... }` commands silently skip subsequent steps; run build/tests as
separate commands.

## Database / Migration State

- Migration files (5 total, oldest → newest):
  1. `20260820004123_identity_multi_tenancy`
  2. `20260820009000_add_asset_foundation`
  3. `20260821000000_add_equipment_domain`
  4. `20260821010000_add_customer_domain`
  5. `20260821020000_add_reservation_domain` ← created + applied in Phase 2G
- Migrations applied: all 5 (`prisma migrate status` → up to date).
- Prisma Client generation: current (v6.19.3, regenerated after 2G migration).
- Schema validation: passed (`npx prisma validate`).
- Existing migrations modified: NO (never modify existing migrations).
- Destructive operations: NONE (no `migrate reset`, no `migrate resolve`, no
  `migrate dev`, no `db push`).
- Constraint reminder: `btree_gist` extension + EXCLUDE constraint exist only
  via the hand-written SQL; keep deploy-only discipline.

## Git / Workspace State

Verified via `git status --short` immediately after gate completion:

- Modified (tracked):
  - `prisma/schema.prisma`
  - `src/app.module.ts`
  - `src/common/database/prisma/tenant-scoping.extension.ts`
  - `src/member/member.controller.ts` (predates 2G — earlier phase work)
  - `src/member/member.service.spec.ts` (predates 2G)
  - `src/member/member.service.ts` (predates 2G)
  - `src/rbac/permission-catalog.ts`
- Untracked:
  - `prisma/migrations/20260820009000_add_asset_foundation/`
  - `prisma/migrations/20260821000000_add_equipment_domain/`
  - `prisma/migrations/20260821010000_add_customer_domain/`
  - `prisma/migrations/20260821020000_add_reservation_domain/`
  - `src/asset/`, `src/customer/`, `src/equipment/`, `src/reservation/`,
    `src/store/`
  - `src/member/dto/create-member.dto.ts`,
    `src/member/onboarding.integration.spec.ts`
  - `docs/phase-progress.md` (this file)
- Staged: none.
- Commits: none made in recent sessions (entire 2D–2H work is uncommitted).
- Pushes: none.
- `.env` touched: NO (never inspected or modified).
- Workspace-boundary status: respected — all work strictly inside
  `C:\khanh\python\12\downloads\vibecode\OpenCode\5`.

## Known Limitations / Deferred Work

- ~~Lifecycle transitions have NO clock enforcement~~ RESOLVED in Phase 2I:
  `start` requires now >= startAt and `complete` requires now >= endAt
  (409 + dedicated messages otherwise).
- Integration-spec `afterAll` cleanup uses `deleteMany` OUTSIDE
  `tenantContext.run()` with a swallowed `.catch(() => undefined)` — silent
  no-op risk if scoping blocks the delete. Pattern replicated across suites
  for consistency per instruction; tenant cascade ultimately cleans rows when
  tenants are deleted. Deferred by instruction — do not "fix" casually.
- ~~`ACTIVE`/`COMPLETED` enum values are currently unreachable~~ RESOLVED in
  Phase 2H (`start`/`complete` endpoints) with clock-aware gating from
  Phase 2I.
- The EXCLUDE constraint requires the `btree_gist` extension on any target
  database (created idempotently by the migration).
- Migration must remain deploy-only: `prisma migrate dev/diff` would drop the
  hand-written CHECK/EXCLUDE constraints.
- 2 pre-existing lint errors in `src/asset/asset.service.spec.ts` (lines 170,
  188) remain intentionally unfixed (out of scope).

## Next Action

NEXT ACTION:
1. Review the Phase 2J architecture assessment (2J section at the top of this
   file).
2. Do not modify code/schema/tests — the read-only mandate stands until the
   user explicitly approves implementation.
3. Upon approval: add the implementation plan to the 2J section, then
   implement in order (utility -> reservation pilot -> other domains ->
   indexes/migration -> tests -> full gate).
4. If the user requests changes to the assessment, update the 2J section and
   re-present before implementing.

## Phase Completion Summary

- Objective: Reservation Domain Foundation — tenant-scoped customer↔equipment
  bookings with UTC half-open windows, two-layer overlap protection, soft
  cancel, RESTRICT-linked lifecycle, RBAC-gated API.
- Result: COMPLETE — implemented, tested, migrated, fully verified.
- Files changed: `prisma/schema.prisma`;
  `prisma/migrations/20260821020000_add_reservation_domain/` (new);
  `src/common/database/prisma/tenant-scoping.extension.ts`;
  `src/rbac/permission-catalog.ts`; `src/app.module.ts`;
  `src/reservation/` (module, controller, service, dto + 3 spec files, new);
  `src/customer/customer.service.ts` + `src/asset/asset.service.ts` (P2003→409).
- Tests: unit 356/356 (27 suites); integration 321/321 (13 suites; reservation
  suite 46 tests incl. concurrency arbitration).
- Verification: format/lint/build/unit/integration/migrate status/git diff
  --check all green (lint clean except 2 documented pre-existing errors).
- Migration: `20260821020000_add_reservation_domain` applied; status up to
  date; no destructive operations; existing migrations untouched.
- Known issues: none unresolved for this phase (pre-existing lint errors and
  deferred items listed above).
- Deferred work: lifecycle transitions (ACTIVE/COMPLETED); afterAll cleanup
  pattern; btree_gist prerequisite note; deploy-only migration discipline.
- Next phase recommendation: await user approval; natural candidates are
  reservation lifecycle transitions or pagination/filtering for list endpoints.
