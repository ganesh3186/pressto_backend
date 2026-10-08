// One-off backfill: recomputes Shift.closing.revenue for already-CLOSED
// shifts using the payment-date + proration logic that ShiftController.
// resolveRevenue() now uses — revenue books on the shift a payment was
// actually RECEIVED in, not the shift the order happened to be created in
// (an order placed 1 Oct but paid at delivery on 7 Oct now books its
// revenue on 7 Oct's shift). Needed because Shift.closing is a one-time
// snapshot: fixing resolveRevenue() only changes shifts closed AFTER the
// fix deployed — it can never retroactively touch history on its own.
//
// Scope: shifts with status = 'closed' AND closedAt within the last N days
// (default 60 — "past 2 months"). ONLY closing.revenue is touched — every
// other field inside closing (collections, banking, pettyCash, salesReturn,
// denominations, remarks, register, actualCashInTill, etc.) is left
// completely untouched, exactly as the cashier submitted it.
//
// This mirrors ShiftController.resolveRevenue() exactly (same proration-by-
// amount-paid, same settle-once-for-tickets/items/services rule). If that
// function's logic ever changes, mirror the change here too, or this
// backfill drifts from what the live code actually does.
//
// SAFE BY DEFAULT — dry-run unless --apply is passed. Dry-run prints a full
// before/after table for every shift whose revenue would change, and writes
// nothing. Before any real write, the complete set of old+new revenue
// cells is saved to a timestamped JSON file next to this script, so a
// specific shift's old figure can be restored by hand if anything looks
// wrong afterward.
//
// Usage:
//   node scripts/backfill-shift-revenue-by-payment-date.js                    (dry run, default — 60 days)
//   node scripts/backfill-shift-revenue-by-payment-date.js --apply            (writes changes — 60 days)
//   node scripts/backfill-shift-revenue-by-payment-date.js --apply --since-days=90
//   node scripts/backfill-shift-revenue-by-payment-date.js --apply --shift-ids=<uuid>,<uuid>
//
// --shift-ids narrows to exactly those shifts (ignores --since-days entirely)
// — use this for a small, already-verified pilot run before trusting a wide
// date-range --apply against a live database.
//
// Connection: DATABASE_URL if set, else PG_HOST/PG_PORT/PG_USER/PG_PASSWORD/
// PG_DATABASE — same names this repo's own .env already uses. Point these
// (via env vars, or a .env file in the working directory) at whichever
// database you actually want to backfill before running — this script
// itself never assumes which one that is.

try {
  require('dotenv').config();
} catch (e) {
  // dotenv not installed on this box — fine, rely on real env vars instead.
}

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const isApply = process.argv.includes('--apply');
const sinceDaysArg = process.argv.find((a) => a.startsWith('--since-days='));
const sinceDays = sinceDaysArg ? Number(sinceDaysArg.split('=')[1]) : 60;
const shiftIdsArg = process.argv.find((a) => a.startsWith('--shift-ids='));
const shiftIds = shiftIdsArg
  ? shiftIdsArg
      .split('=')[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : null;

function buildClient() {
  if (process.env.DATABASE_URL) {
    return new Client({ connectionString: process.env.DATABASE_URL });
  }
  return new Client({
    host: process.env.PG_HOST,
    port: process.env.PG_PORT,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });
}

function emptyCell() {
  return { revenue: 0, discount: 0, taxes: 0, totalSales: 0, tickets: 0, items: 0, services: 0 };
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** Mirrors ShiftController.resolveRevenue() exactly. */
async function computeRevenueCell(client, storeId, from, to) {
  const cell = emptyCell();

  // Not filtered to riderid is null — rider-collected COD is still real
  // revenue, just not yet in the store's physical till.
  const { rows: windowPayments } = await client.query(
    `select orderid, amount from payment_transaction
     where transactiontype != 'refund'
       and paymentdate between $1 and $2`,
    [from, to]
  );
  if (!windowPayments.length) return cell;

  const windowAmountByOrder = new Map();
  for (const p of windowPayments) {
    windowAmountByOrder.set(p.orderid, (windowAmountByOrder.get(p.orderid) || 0) + Number(p.amount));
  }

  const { rows: orders } = await client.query(
    `select id, subtotal, discountamount, taxamount, totalamount from orders
     where id = any($1::uuid[]) and storeid = $2 and status not in ('draft', 'cancelled')`,
    [[...windowAmountByOrder.keys()], storeId]
  );
  if (!orders.length) return cell;
  const touchedOrderIds = orders.map((o) => o.id);

  const { rows: historyPayments } = await client.query(
    `select orderid, amount, paymentdate from payment_transaction
     where orderid = any($1::uuid[]) and transactiontype != 'refund'`,
    [touchedOrderIds]
  );
  const paidBeforeWindow = new Map();
  for (const p of historyPayments) {
    if (new Date(p.paymentdate).getTime() < from.getTime()) {
      paidBeforeWindow.set(p.orderid, (paidBeforeWindow.get(p.orderid) || 0) + Number(p.amount));
    }
  }

  const settledOrderIds = [];
  for (const order of orders) {
    const windowAmount = windowAmountByOrder.get(order.id) || 0;
    if (windowAmount <= 0) continue;
    const total = Number(order.totalamount) || 0;
    const fraction = total > 0 ? Math.min(1, windowAmount / total) : 0;

    cell.totalSales += windowAmount;
    cell.revenue += (Number(order.subtotal) || 0) * fraction;
    cell.discount += (Number(order.discountamount) || 0) * fraction;
    cell.taxes += (Number(order.taxamount) || 0) * fraction;

    const before = paidBeforeWindow.get(order.id) || 0;
    if (total > 0 && before < total - 0.005 && before + windowAmount >= total - 0.005) {
      settledOrderIds.push(order.id);
    }
  }

  cell.tickets = settledOrderIds.length;
  if (settledOrderIds.length) {
    const { rows: items } = await client.query(
      `select quantity, additionalserviceids from order_item where orderid = any($1::uuid[])`,
      [settledOrderIds]
    );
    for (const item of items) {
      const qty = Number(item.quantity) || 0;
      cell.items += qty;
      const extraCount = Array.isArray(item.additionalserviceids) ? item.additionalserviceids.length : 0;
      cell.services += qty * (1 + extraCount);
    }
  }

  cell.revenue = round2(cell.revenue);
  cell.discount = round2(cell.discount);
  cell.taxes = round2(cell.taxes);
  cell.totalSales = round2(cell.totalSales);
  return cell;
}

async function main() {
  const client = buildClient();
  await client.connect();

  try {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const { rows: shifts } = shiftIds
      ? await client.query(
          `select id, storeid, openedat, closedat, closing from shift
           where id = any($1::uuid[])
           order by closedat asc`,
          [shiftIds]
        )
      : await client.query(
          `select id, storeid, openedat, closedat, closing from shift
           where status = 'closed' and closedat >= $1
           order by closedat asc`,
          [since]
        );

    if (!shifts.length) {
      console.log(
        shiftIds
          ? `None of the given --shift-ids were found.`
          : `No closed shifts found in the last ${sinceDays} days.`
      );
      return;
    }
    if (shiftIds && shifts.length !== shiftIds.length) {
      console.log(
        `WARNING: asked for ${shiftIds.length} shift(s), found ${shifts.length} — some id(s) didn't match any shift.`
      );
    }

    console.log(
      shiftIds
        ? `${isApply ? 'APPLYING' : '[DRY RUN]'} — recomputing revenue for ${shifts.length} specific shift(s).\n`
        : `${isApply ? 'APPLYING' : '[DRY RUN]'} — recomputing revenue for ${shifts.length} shift(s) closed since ${since.toISOString()}.\n`
    );

    const backupRows = [];
    let changedCount = 0;
    let totalOldRevenue = 0;
    let totalNewRevenue = 0;

    for (const shift of shifts) {
      const closing = shift.closing || {};
      const oldCell = closing.revenue?.pressto || emptyCell();
      const newCell = await computeRevenueCell(client, shift.storeid, shift.openedat, shift.closedat);

      const delta = round2(newCell.revenue - (Number(oldCell.revenue) || 0));
      totalOldRevenue += Number(oldCell.revenue) || 0;
      totalNewRevenue += newCell.revenue;

      if (Math.abs(delta) > 0.005 || Number(oldCell.tickets) !== newCell.tickets) {
        changedCount += 1;
        console.log(
          `  Shift ${shift.id} (closed ${new Date(shift.closedat).toISOString().slice(0, 10)}): ` +
            `revenue ${oldCell.revenue ?? 0} -> ${newCell.revenue} (${delta >= 0 ? '+' : ''}${delta}), ` +
            `tickets ${oldCell.tickets ?? 0} -> ${newCell.tickets}`
        );
      }

      backupRows.push({
        shiftId: shift.id,
        storeId: shift.storeid,
        closedAt: shift.closedat,
        oldRevenue: oldCell,
        newRevenue: newCell,
      });

      if (isApply) {
        const newClosing = { ...closing, revenue: { pressto: newCell } };
        await client.query(`update shift set closing = $1::jsonb where id = $2`, [
          JSON.stringify(newClosing),
          shift.id,
        ]);
      }
    }

    const backupPath = path.join(
      __dirname,
      `shift-revenue-backfill-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    );
    fs.writeFileSync(backupPath, JSON.stringify(backupRows, null, 2));

    console.log(`\n${changedCount} of ${shifts.length} shift(s) have a different revenue figure.`);
    console.log(`Total revenue (old): ${round2(totalOldRevenue)}`);
    console.log(`Total revenue (new): ${round2(totalNewRevenue)}`);
    console.log(`Backup of every shift's old+new revenue written to: ${backupPath}`);
    console.log(
      isApply
        ? 'Done — changes written.'
        : 'Dry run complete — nothing was written. Re-run with --apply to write.'
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('ERR', err.message);
  process.exit(1);
});
