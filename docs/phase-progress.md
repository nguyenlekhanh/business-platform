--- 

## P5-U5 — COMMERCE INTEGRATION DECISION REVIEW (2026-09-02)

STATUS: DECISION REVIEW COMPLETE — analysis documented; decisions C1-C8, B10
analyzed with recommendations. NO production code, schema, migrations,
APIs, DTOs, or RBAC created. Decision review documentation created at
docs/phase5_p5u5_decision_review.txt.

KEY FINDINGS:
- Booking = Service + time only (Architecture A, frozen P5-U4).
- Order/Payment state machines FROZEN. PosSale additive provenance pattern exists.
- Customer tenant-scoped, optional/nullable on Booking (B13 Option B).
- EXCLUDE constraint on (serviceId, tstzrange) WHERE status IN ('BOOKED','CONFIRMED','ACTIVE').
- Customer optional/nullable (Order walk-in precedent). Cross-store allowed.
- Service has NO price (B23 NO pricing). Order pays via Variant->Price.
- EXCLUDE constraint on serviceId = service time capacity (not goods inventory).
- Customer optional/nullable (Order walk-in precedent). Cross-store allowed.
- Service has NO price (B23 NO pricing). Order pays via Variant->Price.
- EXCLUDE constraint on serviceId = service time capacity (not goods inventory).

MODEL ANALYSIS (Booking<->Order):
- Model A (No link): Pure temporal, no monetization
- Model B (Additive provenance, PosSale pattern): RECOMMENDED
- Model C (Synchronous Order creation): Couples temporal+financial
- Model D (Order references Booking): Clean separation, supports 1:N

RECOMMENDED: Model B (Additive provenance, PosSale pattern). Booking->Order optional link.
Order/Payment state machines untouched. Payment/refund/inventory at Order level.

RECOMMENDED DECISION SET:
C1 = Option B (Optional FK Booking->Order, nullable, RESTRICT, P2003->409)
C2 = "Later checkout" (Order created later via POS/checkout)
C3 = Out of scope for P5-U5 (payment at Order level)
C4 = Status only (Booking CANCELLED; Order uses existing T3 if linked)
C5 = None (no refunds; B19 deferred)
C6 = None (pricing at Order via Variant->Price; Service has no price)
C7 = No consumption (EXCLUDE protects service time; Inventory for goods)
C8 = Natural key (BookingId) -- checkout idempotent via Booking existence
B10 = UTC-only (implementation convention; presentation-timezone deferred)

LABELS:
- ARCHITECTURALLY RECOMMENDED: C1, C2, C3, C4, C5, C6, C7, C8, B10
- BUSINESS DECISION REQUIRED: (none -- all have architectural recommendation)
- DEFERRED: B3/B15 (lifecycle), B4/B8 (availability), B6/B7 (staff), B9 (capacity),
  B17/B18/B19 (payment/refund), B20 (inventory), B22 (EXCLUDE target frozen)

EXPLICITLY NOT IN P5-U5: Staff, Resource, Schedule, Availability, Pricing, Payment timing,
Order links, Inventory consumption, Refunds, Duration, Store-scoping, Delete endpoint.

MINIMUM P5-U5 SCOPE IF APPROVED:
1. Add optional orderId FK to Booking (nullable, RESTRICT, P2003->409)
2. POST /bookings/:id/checkout -> creates Order (T1) + links to Booking
3. GET /bookings/:id/order -> returns linked Order
4. RBAC: booking:manage + order:create for checkout

FILES: docs/phase5_p5u5_decision_review.txt created

VERIFICATION: Report created; no production code modified; full regression passes

GIT: commit docs(phase5): add P5-U5 commerce integration decision review; push SUCCESS

NEXT STEP: Await explicit user approval of C1-C8, B10 before P5-U5 implementation. HARD STOP.

---