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
