# SIYMON Multi-Business Delivery Platform — Architecture & Operations Guide

## 1. Repository Architecture Summary
SIYMON is a multi-role, multi-business delivery platform engineered for **Berrechid, Morocco** and extensible to additional cities (`ServiceZone`).
- **Backend (`server.js` + `lib/*`)**: Node.js / Express monolith serving role-isolated REST APIs, real-time H3 spatial dispatch (`h3-js`), road-distance routing (`OSRM` / `OpenRouteService`), reverse geocoding (`Nominatim`), tamper-evident HMAC-SHA256 audit chains, SHA-256 verified backups, and Web Push notifications.
- **Database & Persistence (`prisma/schema.prisma`, `scripts/migrate-json-to-db.js`)**: Atomic JSON file persistence with SHA-256 verified backup snapshots (`lib/backup.js`) and a full PostgreSQL Prisma schema (`Restaurant`, `RestaurantUser`, `Admin`, `Customer`, `Driver`, `Order`, `OrderItem`, `MenuItem`, `WalletTransaction`, `Promotion`, `ServiceZone`, `ExceptionCase`, `Complaint`, `Settlement`, `Refund`, `OtpChallenge`, `RefreshToken`, `AuditLog`).
- **Role-Specific Web Applications (`public/*`)**:
  - **Customer Storefront & Orders (`/`, `/orders/`, `/stores/`, `/support/`, `/chat/`, `/notifications/`, `/policy/`)** — token key `siymon_customer_token_v1`.
  - **Driver PWA (`/driver/`)** — token key `SIYMON_DRIVER_TOKEN`.
  - **Supervisor / Admin Dashboard (`/admin/`)** — token key `siymon_admin_token_v2`.
  - **Restaurant Dashboard (`/restaurant/`)** — token key `siymon_restaurant_token_v1`.
  - **Multi-Activity Store Dashboard (`/store/`)** — token key `siymon_store_token`.

---

## 2. Core Domain Modules (`lib/*`)
| Module | Responsibilities |
|---|---|
| `lib/security-rbac.js` | Granular supervisor RBAC (`system_admin`, `order_supervisor`, `driver_supervisor`, `accountant`, `support_agent`), store employee privilege-escalation guard, SHA-256 Phone OTP challenge/proof lifecycle, session/token revocation, and tamper-evident HMAC-SHA256 audit log chain (`createTamperEvidentAuditEntry`, `verifyAuditChain`). |
| `lib/order-lifecycle.js` | Server-validated order state machine (`canTransitionStatus`), pre-acceptance customer edit/cancel rules (`canCustomerEdit`, `canCustomerCancel`), and independent SHA-256 pickup & delivery verification codes (`initOrderVerification`, `verifyStageCode`, `supervisorOverrideVerification`, `sanitizeOrderVerificationForRole`). |
| `lib/service-zones-pricing.js` | Berrechid service zones (polygon + radius + max road distance) separate from H3 rings, road-distance per-km delivery fee calculation (no base fee by default), and driver earnings calculation (`calculateRoadDeliveryPricing`). |
| `lib/finance-wallet.js` | SIYMON in-app customer wallet ledger (`creditWallet`, `debitWallet`), idempotency & concurrency guards, split payment planner (`planOrderPayment`), HMAC-verified electronic payment webhooks, per-business commission snapshots, manual merchant settlements, authorized refunds, promotions, and loyalty points. |
| `lib/exceptions-moderation-reports.js` | Unified Supervisor Exception Center (`openExceptionCase`, `resolveExceptionCase`), rating comment moderation (`moderateReviewComment`), complaint routing & escalation (`createComplaint`, `escalateComplaint`), and role-scoped CSV / Excel (`.xlsx` XML) / PDF report generation. |
| `lib/dispatch-core.js` & `lib/dispatch-service.js` | Real `h3-js` hexagonal cell discovery (`gridDisk`), ring-by-ring outward search stopping at the first ring with eligible drivers, re-offer once to the same driver on timeout (`reofferOnceOnTimeout`), supervisor alert on repeated driver rejections, atomic single-driver assignment, and auto-reassignment when a driver reports an issue before pickup. |
| `lib/catalog.js` & `lib/pickup-location.js` | Operating hours, holiday closures, `nextOpenTime`/`opensAt` calculation, scheduled product discounts, daily availability time windows, and `showPickupOnDriverMap` visibility control (hiding pickup pin from the driver map while keeping the business visible to customers). |
| `lib/backup.js` | SHA-256 verified backup creation (`createBackup`), manifest integrity verification (`verifyBackup`), listing (`listBackups`), and safe restoration (`restoreBackup`). |

---

## 3. Security & Privacy Controls
- **Strict Tenant Isolation**: Every `/api/store/*` and `/api/restaurant/*` request is scoped to the authenticated business ID from the server record; cross-store access is blocked and covered by automated tests.
- **Location Privacy**:
  - Unassigned drivers never receive customer name, phone, or exact address during offer dispatch.
  - Customers only see the assigned driver's live GPS after driver assignment until order completion or cancellation.
  - Optional customer live location sharing (`POST /api/customer/orders/:id/share-location`) is only accepted during active delivery and is automatically cleared upon delivery or cancellation.
- **Private Driver Documents & Access Auditing**:
  - Driver identity and licence files are stored outside `public/` and accessed only via `GET /api/admin/drivers/:id/image/:kind` or `GET /api/admin/drivers/:id/documents`, both of which record an immutable audit entry (`driver_document_accessed` / `driver_documents_accessed`).
- **Pickup & Delivery Verification Codes**:
  - Two independent 6-digit codes hashed with SHA-256 (`pickupCode` shown only to the store/restaurant; `deliveryCode` shown only to the customer), with attempt limits, expiry, one-time use, and audited supervisor override.

---

## 4. Verification & Testing
Run the full automated test suite (126 tests across 18 test files):
```bash
npm test
```
Create and verify a SHA-256 data backup before migrations or sensitive updates:
```bash
node -e 'const b = require("./lib/backup").createBackup({ label: "manual_snapshot" }); console.log(b);'
```
