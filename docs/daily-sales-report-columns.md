# Consolidated Daily Sales Report — Column Reference

What every column in the Daily Sales Report (DSR) means and exactly how it's
calculated, as of **10 Oct 2026**. Source: `buildConsolidatedDailySales()` in
[`src/services/reports.service.ts`](../src/services/reports.service.ts), fed
by `resolveRevenue()` / `resolveSalesReturn()` / `collected()` in
[`src/controllers/shift.controller.ts`](../src/controllers/shift.controller.ts).

## How a row is built, in one paragraph

The report is **never computed fresh from live order data for its own sake**.
Almost every figure comes straight off `Shift.closing` — a one-time snapshot
written the moment a shift is closed (`ShiftController.close()`), built from
whatever the cashier's closing form actually submitted. One row = one
`(store, calendar day)` pair — every shift closed at that store on that day
gets summed into the same row, so a store with two shifts in one day shows
one line with `Closure No` listing both (e.g. `"32, 33"`). Only two things
are ever recomputed live, straight from the database, instead of read off a
stored snapshot: **PSB/P2D revenue split** and **Other Payment Mode** — both
explained below.

---

## Identification columns

| Column | Meaning | Source |
|---|---|---|
| **Day** | Day of the week | Derived from the shift's `closedAt` |
| **Date** | Calendar date this row groups by | The shift's `closedAt`, as `YYYY-MM-DD` |
| **Closure No** | Which shift closure number(s) rolled into this row | Every shift closed that `(store, day)` contributes its own closure number (or opening number if none), joined with `", "` |
| **Store Code / Name** | The store | Looked up from the shift's `storeId` |
| **Cluster / Region** | The store's cluster/region | Looked up via the store's own cluster/region assignment |

---

## Revenue columns

**Revenue books on the day the INVOICE is generated — never the day the
order was placed, and never the day payment comes in.** Confirmed directly
with the finance team (Oct 2026): an order placed 1 Oct, invoiced 3 Oct, paid
8 Oct books its revenue on **3 Oct's** shift. Payment date is a completely
separate concern — see **Total Receipts** below.

An order is invoiced **exactly once** — unlike payment, which can split
across several visits, invoicing is a single, deliberate action
(`POST /orders/{id}/invoice/generate`, or the On Account consolidated
equivalent), gated to order status Ready/Partially Dispatched/Out for
Delivery/Delivered. It is **never automatic** — nothing generates an invoice
on its own when an order is created, delivered, or paid. If invoices aren't
being generated routinely for orders, Revenue will show close to nothing for
that store/day — that's a sign invoicing needs to happen more consistently,
not a bug in the report.

| Column | Meaning | Formula |
|---|---|---|
| **Revenue** | Pre-tax, post-discount value of everything invoiced this shift | Sum of `Invoice.subtotal` for every invoice **generated** (`createdAt`) within the shift's `[openedAt, closedAt]` window, for orders at this store |
| **Discount** | Discount applied on those same invoices | Sum of `Invoice.discount` for the same invoice set |
| **Taxes** | GST on those same invoices | Sum of `Invoice.cgst + Invoice.sgst` for the same invoice set |
| **Total Sales** | Final invoiced total (Revenue + Taxes, net of Discount) | Sum of each order's `orderTotal` share of its invoice (see *consolidated invoices*, below) |
| **No Of Tickets** | How many distinct orders got invoiced this shift | Count of distinct orders whose invoice falls in this window |
| **No Of Items** | Garment count across those invoiced orders | Sum of `quantity` across every `OrderItem` row on those orders |
| **No Of Services** | Service-applications across those invoiced orders | Per item: `quantity × (1 + number of additional services on it)` — e.g. 2 shirts with one extra service each = 4, not 2 |
| **PSB Revenue** | Revenue from walk-in/counter orders (store drop-off) | Same invoice set as Revenue, filtered to orders whose `orderType` is `store_dropoff` or `store_dropoff_home_delivery`, recomputed live (see note below) |
| **PMU Revenue** | — | Always `0`. Nothing in the schema records a "PMU" sales channel — this column exists in the report layout but has no data source |
| **P2D Revenue** | Revenue from home-pickup orders | Same as PSB Revenue, filtered to `home_pickup` / `home_pickup_home_delivery` orderType |

**Consolidated (On Account) invoices**: one invoice can cover several
orders at once. Its `subtotal`/`discount`/`cgst`/`sgst` are the **sum**
across every order it covers, with no stored per-order split — so each
linked order's share is prorated by `that order's total ÷ the invoice's
total`. A normal (non-consolidated) invoice already belongs to exactly one
order, so no proration is needed.

**Why PSB/P2D is "recomputed live, not read off the snapshot"**: the closing
form only ever captures one combined `pressto` revenue figure — it never
splits it by sales channel. So PSB + P2D are rebuilt here, at report-read
time, using the *exact same* invoice-generation-date + proration logic as
Revenue itself (so the two always add up to the same total) — the only
reason this one figure isn't simply read verbatim off `Shift.closing`.

---

## Payment mode / Collection columns

**This is Collection — a completely separate concept from Revenue.**
Collection books on the day **money is actually received**, regardless of
when the order was invoiced. The 8 Oct example above: that order's ₹1000
shows as Collection on **8 Oct**, Revenue on 3 Oct.

Every column in this section is read straight off `Shift.closing` — exactly
what the cashier's closing form showed, with one exception (**Other Payment
Mode**, flagged below).

| Column | Meaning | Source |
|---|---|---|
| **Cash** | Cash collected this shift | `closing.collections.cash` |
| **Cards/UPI** | Card + UPI collected this shift | `closing.collections.card + closing.collections.upi` |
| **Cheques Received** | Cheque + PDC collected this shift | `closing.collections.cheque` (PDC is bucketed into the same figure at closing-prefill time) |
| **PG Link** | Net Banking + Bank Transfer + Razorpay Gateway collected this shift | `closing.collections.pgLink` (all three modes are folded into one bucket at closing-prefill time) |
| **Wallet Redemption** | Stored wallet BALANCE used against a ticket (no fresh money in) | `closing.collections.wallet` |
| **Wallet Recharged Cash** | Cash taken in specifically to top up a customer's wallet | `closing.walletCollections.cash` — a separate money-in event from a ticket payment |
| **Wallet Recharge Card/UPI/Other** | Card/UPI/Net-Banking taken in for wallet top-ups | `closing.walletCollections.card + .upi + .netBanking` |
| **PP Vouchers** | Prepaid voucher redemptions | `closing.collections.ppVoucher` |
| **Reimbursed** | Cash refunded back to customers (sales returns paid out in cash) | `closing.register.reimbursement` |
| **Other Payment Mode** | Net Banking / Bank Transfer / PDC / Pay Later payments | **Recomputed live** — summed directly from real `PaymentTransaction` rows (by `paymentMode`, within the shift's window), not read off the snapshot |
| **Total Receipts** | Everything collected this shift, all modes combined | `Other Payment Mode + PP Vouchers + Cash + Cards/UPI + Cheques Received + PG Link + Wallet Redemption` |

> ⚠️ **Known overlap, not yet resolved**: "Other Payment Mode" independently
> re-sums Net Banking, Bank Transfer, and PDC payments from live
> `PaymentTransaction` data — but those same three modes are **also**
> already folded into **PG Link** and **Cheques Received** respectively at
> closing-prefill time (see `ShiftController.collected()`'s own bucket map).
> That means `Total Receipts` currently **double-counts** any Net
> Banking/Bank Transfer/PDC payment — once via PG Link/Cheques Received,
> once again via Other Payment Mode. Only **Pay Later** genuinely has no
> other bucket and needs to stay in Other Payment Mode. This needs a
> decision before it's fixed — flagged separately, not silently changed, since
> narrowing Other Payment Mode's definition changes reported totals.

---

## Banking columns

| Column | Meaning | Source |
|---|---|---|
| **Supposed Bank Deposit** | How much should have gone to the bank this shift | `closing.banking.supposed` — cashier-submitted |
| **Actual Bank Deposit** | How much actually got deposited | `closing.banking.deposited` — cashier-submitted |
| **Diff In Deposit** | Shortfall/excess | `Supposed Bank Deposit − Actual Bank Deposit` |

---

## Sales Return columns

Independent of Revenue above — **not** subtracted from it, shown as its own
activity. Booked on the day the return is **approved** (`resolvedAt`, or
`updatedAt`/`createdAt` as fallbacks), not the day of the original sale.

| Column | Meaning | Formula |
|---|---|---|
| **No Of Sales Return Services** | Service-applications on the returned items | Same `quantity × (1 + additional services)` formula as the revenue side, applied to each returned item |
| **Sales Return Sale Amount** | Pre-tax value of what was returned | `SalesReturn.creditAmount` is stored tax-inclusive — split back out using the active GST rate: `preTax = creditAmount ÷ (1 + GST%)`. Revenue += preTax, Taxes += (creditAmount − preTax), Total Sales += creditAmount. **Discount is always 0** here — SalesReturn tracks no discount component (a known data gap, not a bug) |

---

## Remarks & reconciliation columns

| Column | Meaning | Source |
|---|---|---|
| **Shift Open Remark** | Remarks entered when each shift opened | Joined across every shift in the row, prefixed with that shift's closure number |
| **Shift Closing Remark** | Remarks entered when each shift closed | Same, from the closing form |
| **Cumulative Difference** | Running reconciliation gaps carried forward | `CT` (Cash in Till), `PC` (Petty Cash), `PV` (Prepaid Voucher), `BD` (Banking) — each is that figure's `cumulativeDiff` from the **last** shift closed that day in this row (not summed across shifts, since these are running totals already) |

---

## History of this logic (for context)

Revenue's definition has changed twice in quick succession as the real
business rule got clarified:

1. **Originally**: keyed off order `createdAt` — booked revenue the moment
   an order was created, regardless of whether it was ever paid or invoiced.
   Overstated revenue for any order not yet actually settled.
2. **Then (early Oct 2026)**: keyed off `PaymentTransaction.paymentDate`,
   prorated across shifts for split payments. Fixed the overstatement, but
   turned out not to match how finance actually wants revenue recognized.
3. **Now (confirmed with finance, 10 Oct 2026)**: keyed off `Invoice.createdAt`
   — the invoice generation date. Payment date became **Collection**, a
   separate, correctly-already-existing set of columns (Cash/Cards/UPI/
   PG Link/etc. + Total Receipts) that was never touched by any of this —
   it was always payment-date-based.
