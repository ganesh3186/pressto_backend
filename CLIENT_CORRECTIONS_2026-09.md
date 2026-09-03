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
