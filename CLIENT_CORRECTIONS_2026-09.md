# Client Corrections — September 2026

Running log of corrections raised by the client, fixed one at a time. Each
entry: what was reported, root cause, the fix, and the commit(s).

---

## 1. Tax invoice print shows "REVISED SERVICE ORDER" instead of the real invoice

**Status:** ✅ Fixed

**Reported:** On a fully paid, finalized order, printing the invoice showed
the heading "REVISED SERVICE ORDER" with "Estimated Sub-Total / Estimated
CGST / TOTAL ESTIMATED VALUE" wording, instead of the actual tax invoice.

**Root cause:** The Order Summary dialog's thermal "Print" button
(`order-invoice-dialog.js`, next to the separate "Print invoice" button) was
hardcoded to always request `RECEIPT_TYPE.REVISED_SERVICE_ORDER` — an
estimate-only document — regardless of whether the order already had a real,
finalized `Invoice` record. The document-rendering code itself
(`thermal-receipt.js`) already correctly switches to real invoice numbers
and drops the "Estimated" wording when told `type: 'tax_invoice'` — another
screen (Manage Invoice list) was already calling it correctly. Only this one
button was passing the wrong type, always.

**Fix:** That button now checks whether the order has a persisted invoice —
same check the working screen already uses — and requests `TAX_INVOICE`
(real totals) when one exists, `REVISED_SERVICE_ORDER` (estimate) otherwise.
Also marks the invoice as printed (`markOrderInvoicePrinted`) when it prints
the real one, matching the other button's own behavior.

- Scope: Admin Panel
- File: `src/sections/orders/order-invoice/order-invoice-dialog.js`
- Commit: `865fb77` (pressto-admin-panel)

**Follow-up found while fixing this:** even with the above fix, no order
ever actually had a real invoice to switch to — see item 2.

---

## 2. No way to generate a real invoice for a regular order (delivered or not)

**Status:** ✅ Fixed

**Reported:** Follow-up to item 1 — for an order that's already delivered,
how do you print its real tax invoice?

**Root cause:** Traced every place an `Invoice` row can be created.
`POST /orders/{orderId}/invoice/generate` (per-order tax invoice, gated to
`ready`/`partially_dispatched`/`out_for_delivery`/`delivered`) was fully
built on the backend, with a ready API wrapper (`generateOrderInvoice()` in
`src/api/billing.js`) — but nothing in the admin panel UI ever called it.
The only working invoice-creation path was the separate on-account/B2B
consolidated-invoice flow (`customer-wallet-finance-panel.js`), which
doesn't apply to a regular retail order at all. Net effect: no regular
order — delivered or not — could ever get a real invoice through the UI.

**Fix:** Added a "Generate Invoice" button to the Order Summary dialog,
shown once the order is `ready`+ and has no invoice yet (same gate the
backend enforces). Refreshes the invoice on success so the Print button
(item 1's fix) immediately switches to the real tax invoice.

- Scope: Admin Panel
- File: `src/sections/orders/order-invoice/order-invoice-dialog.js`
- Commit: `168374f` (pressto-admin-panel)

**Follow-up:** superseded item 1's approach — see item 3.

---

## 3. Two dedicated print buttons instead of one that switches behavior

**Status:** ✅ Fixed

**Requested:** Keep "Print order summary" always printing the
order-summary/challan template, and have a separate "Print invoice" button
that always prints the real tax invoice — rather than one button that
silently switches behavior depending on invoice status (item 1's fix).

**Fix:** Reverted "Print order summary" to unconditionally print
`REVISED_SERVICE_ORDER`. Restored the "Print invoice" button (existed in
code but was commented out, so unreachable) — wired to the existing
`handlePrintTaxInvoice`, which already always shows "TAX INVOICE" with real
numbers once an invoice has been generated via item 2's Generate Invoice
button.

- Scope: Admin Panel
- File: `src/sections/orders/order-invoice/order-invoice-dialog.js`
- Commit: `26789da` (pressto-admin-panel)

---

## 4. "REVISED" label showing on order-summary print for every order

**Status:** ✅ Fixed

**Reported:** The "Print order summary" print (on the order challan) always
showed "REVISED SERVICE ORDER" — even for orders that were never actually
edited after creation. Should only say "REVISED" if the order was edited.

**Root cause:** Item 3's revert made this button unconditionally print
`REVISED_SERVICE_ORDER` — it never checked whether an edit had actually
happened.

**Fix:** Checks `orderDetails.statusHistory` for the specific, stable
remark `updateOrderItems()` (the "Edit Order" action) always writes when it
runs ("Items edited at counter..." — the only place order items get
amended anywhere in the codebase). Prints plain `SERVICE_ORDER` when that
never happened, `REVISED_SERVICE_ORDER` when it did. No backend change —
`statusHistory` was already part of the order details response.

- Scope: Admin Panel
- File: `src/sections/orders/order-invoice/order-invoice-dialog.js`
- Commit: `602d447` (pressto-admin-panel)

---

## 5. "Total collected exceeds order total" — additional-service charges leaking across units

**Status:** ✅ Fixed

**Reported:** New Order screen showed Grand Total ₹2545 and submitted with
that as the Cash payment amount; backend rejected with "Total collected
(₹2545) exceeds order total (₹1651)" — a ₹894 gap, far too large to be a
rounding issue.

**User's own diagnosis (correct):** A "Shirt" line with 2 quantities had
additional services ("Alter Large", "Darning Small") selected on only the
first unit, but both units displayed ₹1033 on screen.

**Root cause:** `buildChallanLineFromCartEntry()` (`new-order-pricing.js`)
computed one shared `additionalServiceChargePerUnit` from the *union* of
additional services selected anywhere on the line, then applied it
uniformly to every unit's price — so a unit with no additional services of
its own still got charged for ones only actually selected on a sibling
unit. Confirmed via the real submitted payload: the second Shirt unit
correctly had no `additionalServiceIds`, and backend's total (₹1651) was
the correct one — this was a pure frontend overcharge. Math check: true
base price of the addon-less unit is ₹192 (1033 − 402 − 439); that ₹841
difference, after the order's 10% discount and 18% GST, is ₹893.14 ≈ the
reported ₹894 gap.

**Fix:** Each unit's additional-service charge is now computed from that
unit's own `additionalServiceIds`, falling back to the line-level list
only when a unit has none of its own — same "a unit's own selection wins"
rule the backend already applies in `order.service.ts`'s `createOrder()`.

- Scope: Admin Panel (backend was already correct — no backend change)
- File: `src/utils/new-order-pricing.js`
- Commit: `2ef8024` (pressto-admin-panel)

---

## 6. Sales return on a measurement item (curtain/carpet) refunds unit price, not unit price × area

**Status:** ✅ Fixed

**Reported:** A curtain/carpet item is billed per square metre (length ×
width, entered at the POS screen at intake) — but returning it only
refunded the plain unit price (the per-sqm rate), not unit price × area
(what the customer actually paid for that piece).

**Root cause:** `_applyReturnEffect()` in `approval.service.ts` — the
garment-level "Return Item" approval flow — computed "what this one piece
was billed for" as plain `orderItem.unitPrice`. Correct for a normal
piece-priced item, but for a measurement item that's just the per-sqm
rate, not the actual billed amount for that specific garment. Order
creation bills these as `unitPrice × length × width` per garment
(`order.service.ts`'s `perUnitTotalPrices`) — this refund calculation
never accounted for that.

**Fix:** Now multiplies by the returned garment's own recorded area
(`Garment.length × Garment.width`) when the item is `isMeasurement`,
before applying its share of the order's tax — same rule order creation
itself applies.

**Related, not fixed (flagged for a follow-up, not reported today):**
`_applyUpgradeOnOrderItem()` and `getUpgradeView()` — the separate
"Upgrade" feature — have the identical missing-area-multiplier gap.

- Scope: Backend
- File: `src/services/approval.service.ts`
- Commit: `a30568e` (pressto_backend)

---

## 7. Upgrade repricing had the same missing-area gap as item 6

**Status:** ✅ Fixed

**Root cause:** `_applyUpgradeOnOrderItem()` (applying an approved
upgrade) and `getUpgradeView()` (the customer-facing quote shown before
approval) both computed the new total as `newUnitPrice × orderItem.quantity`
— for a measurement item, only correct if every garment on the line
happens to share the same area.

**Fix:** Both now sum each garment's own recorded area
(`Garment.length × Garment.width`) instead of multiplying by quantity,
same rule order creation applies — so the pre-approval quote and what
actually gets billed on approval always agree. A plain piece-priced item
is unaffected.

- Scope: Backend
- File: `src/services/approval.service.ts`
- Commit: `ff7e340` (pressto_backend)

---

## 8. Order subtotal goes negative + credit notes over-credit after Upgrade → Sales Return

**Status:** ✅ Fixed

**Found via:** live DB trace of `CN-202609-00003` (requested by you) —
journey was create order → upgrade a curtain's service → complete
processing → deliver → sales return.

**Root cause:** `order.taxAmount` was never recalculated when `subtotal`
changed after creation. Two consequences, both real:
1. `_applyUpgradeOnOrderItem()` changed `subtotal` by the price
   difference but left `taxAmount` untouched.
2. `sales-return.controller.ts`'s `create()` then derived an "effective
   tax rate" as `taxAmount ÷ subtotal` to gross up the credit note — with
   `taxAmount` now stale, this produced ~32% instead of the real 18%,
   over-crediting this one credit note by **≈₹291**.
3. `approve()` separately subtracted the tax-*inclusive* `creditAmount`
   directly from the pre-tax `subtotal` field, driving it to **-₹146.57**
   on this exact order — confirmed live.

**Fix:**
- `_applyUpgradeOnOrderItem()` now recomputes `taxAmount` fresh from the
  current GST config against the new subtotal.
- `create()`'s GST gross-up now uses the current real GST rate directly,
  not a derived "effective rate" that can go stale.
- `approve()` now reverses the same gross-up to get the correct pre-tax
  amount to subtract from `subtotal`, and recomputes `taxAmount` fresh too.

**Not fixed, flagged for follow-up:** `OrderService.splitOrder()` derives
the same kind of "effective tax rate" from `taxAmount`/`subtotal` and has
the identical staleness exposure.

- Scope: Backend
- Files: `src/services/approval.service.ts`, `src/controllers/sales-return.controller.ts`
- Commit: `06af122` (pressto_backend)
