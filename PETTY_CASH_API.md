# Petty Cash API — Integration Guide

For the admin panel team. Real backend behind the `Petty Cash Finance` /
`Petty Cash Register` / `Petty Cash Approval` screens
(`src/sections/petty-cash/`), now wired to these endpoints via
`src/api/petty-cash.js` (the old `sessionStorage` mock,
`petty-cash-storage.js`/`use-petty-cash-state.js`, is gone).

**Auth**: `Authorization: Bearer <jwt>`. New permissions (seeded via
`npm run seed:new-permissions`):

| Permission | Grants | Who has it |
|---|---|---|
| `petty_cash:read` | View balance, finance entries, register entries | manager, store_exec, counter_staff, asm, finance |
| `petty_cash_finance:create` | Add a finance top-up | finance only |
| `petty_cash_register:create` | Log an expense | manager, store_exec, counter_staff |
| `petty_cash_register:delete` | Delete a still-pending expense | manager, store_exec, counter_staff |
| `petty_cash_register:update` | Approve/reject an expense | manager only |

The balance is **never stored** — always computed live as:

```
sum(finance entries) − sum(PENDING entries' amount) − sum(APPROVED entries' approvedAmount)
```

An expense reserves its full requested amount the moment it's
**submitted**, not just once a manager resolves it — otherwise two
pending expenses together could claim more cash than the store actually
has. `REJECTED` releases the reservation in full (contributes `0`).
`APPROVED` keeps only `approvedAmount` reserved — on a **partial**
approval the disapproved remainder is released back to the balance the
instant it's resolved. Deleting a still-pending entry (§6) also releases
its reservation, same as a rejection.

---

## 1. Add a Finance Top-Up

```
POST /petty-cash/finance-entries
```
Permission: `petty_cash_finance:create`.

**Body**
```json
{ "storeId": "uuid", "amount": 5000, "remarks": "Opening float for August" }
```

**Response `200`**
```json
{
  "message": "Petty cash amount saved for store.",
  "entry": {
    "id": "uuid", "storeId": "uuid", "storeCode": "ST058", "storeName": "UAT Ashoka Garden",
    "amount": 5000, "remarks": "Opening float for August",
    "createdBy": "uuid", "createdByName": "Finance Team", "createdAt": "..."
  },
  "balance": 9750
}
```
`404` if `storeId` doesn't exist or isn't in the caller's scope.

---

## 2. List Finance Entries

```
GET /petty-cash/finance-entries?storeId=uuid
```
Permission: `petty_cash:read`. `storeId` required. Ordered `createdAt DESC`.

**Response `200`**
```json
{ "entries": [ { "...same shape as §1's entry..." } ] }
```

---

## 3. Get Balance

```
GET /petty-cash/balance?storeId=uuid
```
Permission: `petty_cash:read`.

**Response `200`**
```json
{ "storeId": "uuid", "balance": 9750 }
```

---

## 4. Log an Expense

```
POST /petty-cash/register-entries
```
Permission: `petty_cash_register:create`.

**Body**
```json
{
  "expenseDate": "2026-08-18T11:47:00.000Z",
  "amount": 250,
  "method": "Cash",
  "description": "Employee Welfare",
  "remarks": "TEA"
}
```
`storeId` is **not** normally sent — resolved server-side from the
caller's own `Employee.storeId` (same posture as `POST /shifts`), so a
cashier can't log an expense against a different store. Only a
store-unbound caller (manager, super_admin with no fixed store) needs to
pass `storeId` explicitly.

`userId`/`userName` are resolved from the caller too, never client-supplied.

`400` ("This expense (250) exceeds the available petty cash balance
(100).") if `amount` is more than `GET /petty-cash/balance` would
currently return for this store — the balance already accounts for every
other still-pending expense, so this is a real "can't over-commit the
float" check, not just a sanity check against the funded total.

**Response `200`**
```json
{
  "message": "Expense submitted for approval.",
  "entry": {
    "id": "uuid", "storeId": "uuid", "storeCode": "ST058", "storeName": "UAT Ashoka Garden",
    "userId": "uuid", "userName": "Nitin Varsekar",
    "expenseDate": "...", "amount": 250, "method": "Cash",
    "description": "Employee Welfare", "remarks": "TEA",
    "status": "WAPR",
    "approvedAmount": null, "disapprovedAmt": null,
    "resolvedRemark": null, "resolvedBy": null, "resolvedByName": null, "resolvedAt": null,
    "createdAt": "...", "updatedAt": "..."
  }
}
```
`status` values match the frontend's own `PETTY_STATUS` constant exactly
(`"WAPR"` / `"Approved"` / `"Rejected"`) — rendered raw as a chip label
today with no translation layer, so the backend uses the same literal
strings rather than inventing new ones.

---

## 5. List Expense Entries

```
GET /petty-cash/register-entries?storeId=uuid&status=WAPR
```
Permission: `petty_cash:read`. Both params optional.
- `storeId` omitted → every store the caller can see (store-scoped for
  store_exec/counter_staff, all stores for manager/super_admin/finance/
  asm) — this is the Approval screen's cross-store view.
- `storeId` given → just that store — the Register screen's own view.
- `status` filters to one of `WAPR` / `Approved` / `Rejected`.

Ordered `expenseDate DESC`.

**Response `200`**
```json
{ "entries": [ { "...same shape as §4's entry..." } ] }
```

---

## 6. Delete a Pending Expense

```
DELETE /petty-cash/register-entries/{id}
```
Permission: `petty_cash_register:delete`. Soft-deletes.

`400` if the entry is no longer `WAPR` — once resolved (approved or
rejected), it's permanent. An approved entry has already moved money;
deleting it would silently orphan that balance effect, so it's blocked
outright rather than adding reversal logic nothing asked for.

**Response `200`**
```json
{ "message": "Expense deleted." }
```

---

## 7. Approve / Reject an Expense

```
POST /petty-cash/register-entries/{id}/resolve
```
Permission: `petty_cash_register:update` (manager only).

**Body — approve (full or partial)**
```json
{ "approved": true, "approvedAmount": 200, "remark": "Approved, capped at policy limit" }
```
**Body — reject**
```json
{ "approved": false, "remark": "Not a valid petty cash category" }
```
- `remark` is always required.
- `approvedAmount` required when `approved: true` — must be `> 0` and
  `<= entry.amount`. Approving less than the requested amount is a
  **partial approval**: the shortfall becomes `disapprovedAmt`, and only
  `approvedAmount` is deducted from the store's balance.
- A full rejection sets `disapprovedAmt` to the entire requested amount
  and touches the balance not at all.
- `400` if the entry isn't currently `WAPR`.

**Response `200`**
```json
{
  "message": "Expense approved.",
  "entry": { "...entry, now status: 'Approved', approvedAmount: 200, disapprovedAmt: 50, resolvedRemark, resolvedBy, resolvedByName, resolvedAt..." },
  "balance": 9550
}
```

---

## Shift Management integration

`Shift.opening.pettyCash` / `Shift.closing.pettyCash` (see
`SHIFT_MANAGEMENT_API.md` if one exists, or `shift.controller.ts`) now
read real petty cash data instead of only chaining from a previous
shift's self-reported numbers:

- **`POST /shifts` (open)** — `opening.pettyCash.supposed` is the
  store's **actual live balance** at the moment of opening (via
  `PettyCashService.computeBalance`), not chained from the last closed
  shift like `cashInTill`/`banking`/`prepaidVouchers` still are (no real
  ledger backs those three yet).
- **`GET /shifts/{id}/collected`** — now also returns a `pettyCash`
  object, real activity within `[shift.openedAt, now]`:
  ```json
  "pettyCash": { "recvFromFinance": 5000, "used": 200, "disapprovedAmt": 50 }
  ```
  `recvFromFinance` = finance top-ups created in that window for the
  shift's store. `used` = sum of `amount` on register entries
  **submitted** (`createdAt`-scoped) in that window, regardless of
  status — not "approved this window". `disapprovedAmt` = sum of
  `disapprovedAmt` on entries **resolved** (`resolvedAt`-scoped) in that
  window (partial shortfalls and full rejections both count). An entry
  can be submitted in one shift and resolved in a later one — `used` and
  `disapprovedAmt` are scoped independently on purpose so each shift only
  gets credited/debited for what actually happened during it. Same
  posture as the endpoint's existing `collections`/`bankingSupposed`
  fields: a prefill starting point for the closing form, not a silent
  override — the cashier still submits their own counted numbers on
  close.

  **Why `used` is submitted-not-approved:** the balance now reserves an
  expense's full amount the moment it's *submitted* (see above), not
  once it's approved — so `used` has to mirror that to reconstruct the
  real balance. The closing formula is
  `prevSupposed + recvFromFinance − used + disapprovedAmt` — note
  `disapprovedAmt` is **added back**, not subtracted, since it represents
  a reservation being released, not a second deduction. (Both
  `shift.controller.ts`'s `recalcClosingDerived` and the frontend's
  mirror in `shift-module.js` implement this same formula — they must
  stay in sync; the server always re-verifies the client's math and is
  the actual source of truth.)

The admin panel's `shift-close-view.js` now actually consumes this —
`applyCollectedPrefill` merges `collected.pettyCash` into the closing
form's `pettyCash.recvFromFinance`/`used`/`disapprovedAmt` fields
(previously it merged `collections`/`banking`/`register` from this same
response but silently dropped `pettyCash`, so the Petty Cash section of
the closing form always showed zeros regardless of real activity). The
"Used" field is labeled "Submitted This Shift" in that screen for
clarity, since it no longer means "approved this shift".
