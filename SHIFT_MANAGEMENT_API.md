# POS Shift Open/Close — Admin Panel Integration Guide

For the admin panel team. Real backend for the shift open/close flow that
currently lives 100% in `localStorage` (`src/_mock/shift-module.js`,
`src/utils/shift-module.js`). Field shapes match those files closely on
purpose — `opening`/`closing` mirror `createEmptyOpeningBalances()`/
`createDefaultClosingForm()` field-for-field, so this should be close to a
drop-in swap of the storage layer.

All routes require `Authorization: Bearer <jwt>`.

| Permission | Who has it | Gates |
|---|---|---|
| `shift:create` | `manager`, `store_exec` | Open a shift |
| `shift:read` | `manager`, `store_exec` | View shifts |
| `shift:update` | `manager`, `store_exec` | Close a shift |

**Role note**: the frontend's `POS_SHIFT_ROLE_CODES` also lists `cce`/`cci`
— neither exists as a real backend role today (checked `seed.ts`). Only
`store_exec` and `manager` can open/close for now; add `cce`/`cci` grants
additively via `seed-new-permissions.ts` once those roles actually exist.

---

## Scope of this pass — read before wiring the closing form

**The closing form's ~40 numeric fields stay operator-typed**, exactly
like today — the cashier still counts and types every number. The backend
persists what's typed for real and **recomputes every derived/difference
field server-side** (pure arithmetic — totals, `difference`,
`cumulativeDiff`, `currSupCashInTill` — not trusting whatever the client
computed), but does **not** auto-fetch "expected cash" from real
orders/payments. Two real gaps block that for now, found while building
this:
- **No "brand" concept exists anywhere in `Order`/`Service`** — the
  revenue matrix (Pressto/Cobbler/PMU Plus/B2B × 7 metrics) can't be
  computed server-side until brand-tagging exists somewhere first. Bigger,
  separate initiative.
- **`PaymentMode` doesn't map cleanly to the collection buckets** — no
  `pgLink`/`ppVoucher` payment mode exists; prepaid vouchers look like a
  different concept from a payment method entirely.

Also: `pettyCash.cumulativeDiff` and `actualCashInTill.currClosureBanking`
are passed through exactly as typed, not recomputed — the frontend's own
`recalcClosingDerived()` never defines a formula for either (confirmed by
reading it), so this doesn't invent one. Flag if a formula gets decided.

---

## 1. Open a shift

```
POST /shifts
```
```json
{
  "openingBalances": {
    "cashInTill": {"actual": 2000},
    "banking": {"actual": 0},
    "pettyCash": {"actual": 0},
    "prepaidVouchers": {"actual": 0}
  },
  "remarks": "required"
}
```
`storeId`/`userId` are **not sent** — resolved server-side from the
caller's own `Employee.storeId`. `400` ("Your account is not linked to a
store.") if the logged-in user has no store assignment. Only send
`actual` per category — `supposed` is server-computed (see below), never
client-supplied.

**"Supposed" values** — `pettyCash` is the store's **real, live petty
cash balance** right now (see `PETTY_CASH_API.md` — computed from actual
finance top-ups and approved expenses, not chained). The other three
have no real ledger behind them yet, so they still chain from the
**store's** last `closed` shift (any user, not just this one) —
`cashInTill` from that shift's `actualCashInTill.actual` (falling back
through `register.currSupCashInTill` → its own opening `cashInTill.actual`
→ `0`), `banking` from `banking.inSafe`, `prepaidVouchers` from
`ppVoucher.actualVoucher`. No prior closed shift at this store → defaults
`cashInTill: 2000`, `banking`/`prepaidVouchers`: `0` (same seed values the
mock used) — `pettyCash` still comes from the live balance either way.

`409 Conflict` ("A shift is already open for this user at this store.")
if the caller already has one open here — same rule as today, just
actually enforced.

**Response `200`**
```json
{
  "message": "Shift 1 opened.",
  "shift": {
    "id": "uuid", "openingNo": 1, "closureNo": null,
    "storeId": "uuid", "storeCode": "ST113", "storeName": "Babulnath",
    "userId": "uuid", "userName": "Jane Doe", "status": "open",
    "openedAt": "...", "closedAt": null,
    "openingUserId": "uuid", "openingUserName": "Jane Doe",
    "closingUserId": null, "closingUserName": null,
    "opening": {
      "cashInTill": {"supposed": 2000, "actual": 2000, "difference": 0},
      "banking": {"supposed": 0, "actual": 0, "difference": 0},
      "pettyCash": {"supposed": 0, "actual": 0, "difference": 0},
      "prepaidVouchers": {"supposed": 0, "actual": 0, "difference": 0},
      "remarks": "..."
    },
    "closing": null
  }
}
```

`openingNo` is real per-store sequential numbering (`1, 2, 3...` per
store), replacing the mock's global browser counter that started at 1744.
`closureNo` is set equal to `openingNo` when closed — same number reused,
matching the mock's existing behavior, not two separate sequences.

---

## 2. The caller's own open shift (poll this instead of `localStorage`)

```
GET /shifts/active
```
No params. Resolves the caller's own store automatically. Replaces
`usePosShift({userId, storeId})`'s `getActiveShift()` localStorage read.

**Response `200`**: `{ "shift": {...} }` or `{ "shift": null }` — a valid
answer, not a `404`.

---

## 3. List / detail (for an audit screen, if one gets built)

```
GET /shifts?storeId=&status=
GET /shifts/{id}
```
Store-scoped the same way every other admin list endpoint is — a
`store_exec` only ever sees their own store's shifts regardless of
`storeId`. Ordered `openedAt DESC`.

---

## 4. Close a shift

```
POST /shifts/{id}/close
```
```json
{
  "collections": {"cash": 0, "card": 0, "cheque": 0, "pgLink": 0, "ppVoucher": 0, "wallet": 0},
  "walletCollections": {"cash": 0, "card": 0, "upi": 0},
  "banking": {"supposed": 0, "deposited": 0, "inSafe": 0},
  "prepaidV": {"supposed": 0, "sentToAc": 0, "inSafe": 0},
  "pettyCash": {"prevSupposed": 0, "recvFromFinance": 0, "used": 0, "disapprovedAmt": 0, "actualBalance": 0},
  "cardPgSettlement": {"actualSettlement": 0},
  "ppVoucher": {"currSupVoucher": 0, "actualVoucher": 0},
  "register": {"prevSupCashInTill": 0, "prevActCashInTill": 0, "cashReceived": 0, "reimbursement": 0},
  "actualCashInTill": {"actual": 0},
  "revenue": { "...4-brand × 7-metric matrix, sent as-is..." },
  "salesReturn": { "...same shape as revenue..." },
  "remarks": "required"
}
```
Send the same shape `createDefaultClosingForm()` already builds — this
endpoint accepts it directly, no reshaping needed on your end.

**Validation:**
| Status | Cause |
|---|---|
| `404` | shift not found |
| `400` | shift already closed ("This shift is already closed.") |
| `403` | caller isn't the one who opened it — **server-enforced now**, not just a client-side check |
| `400` | `remarks` missing/blank |

**Server recomputes** (overwriting whatever was sent, don't trust the
client math): `collections.total`, `walletCollections.total`,
`banking.cumulativeDiff`, `pettyCash.balance`/`difference`,
`ppVoucher.difference`, `register.currSupCashInTill`,
`actualCashInTill.difference` — same formulas as `recalcClosingDerived()`.

**Response `200`**: `{ "message": "Shift 1 closed.", "shift": {...status: 'closed', closing: {...recomputed...}} }`

---

## 5. `Order.shiftId` — automatic, no frontend change needed

Every new order (`POST /orders`) now silently carries the creating
cashier's currently-open shift at their store, if one exists —
`shiftId` on the created `Order`. **Not enforced** — an order can still
be created with no open shift, `shiftId` just stays `null` in that case.
This is attribution/audit only; nothing currently reads it back.

---

## Not built this pass

- Real "expected cash"/revenue-by-brand auto-computation from orders and
  payments — blocked on brand-tagging and payment-bucket-mapping
  decisions that don't exist yet anywhere in the system.
- Hard-blocking order creation when no shift is open (currently: silent
  attribution only, see §5).
- Force-close / manager override of another user's open shift.
- Variance-beyond-tolerance → Finance Approvals tie-in.
- A confirmed formula for `pettyCash.cumulativeDiff` /
  `actualCashInTill.currClosureBanking` — passed through as typed.

Flag any of these if they become the next priority.
