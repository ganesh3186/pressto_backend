// Restores the original totals of issued invoices that were overwritten after
// a credit note (sales return) was approved against them.
//
// Cause (fixed in OrderService.syncInvoiceTotalsForOrder / generateInvoiceForOrder):
// after a credit note, the order's totals drop, and the invoice sync copied
// those reduced totals onto the already-issued invoice. Its saved line
// snapshot (invoice.items) still held the original lines, so the admin
// receipt rejected the snapshot as inconsistent and printed no item lines,
// and the credit was counted twice (InvoiceController.creditTotals).
//
// The original totals are recorded on the credit note itself, as
// returnedItems[].invoiceBasis {subtotal, discount, tax, total}. The earliest
// approved credit note for the invoice holds the as-issued values.
//
// Only touches an invoice when all of these hold:
//   - not consolidated,
//   - its saved line snapshot adds up to exactly the basis subtotal
//     (proves the basis describes this invoice as issued),
//   - its current totals differ from the basis.
// balanceDue / amountReceived are left alone: they are already net of the
// credit (they come from the order).
//
// Usage:  npm run repair:credited-invoice-totals            (preview only)
//         npm run repair:credited-invoice-totals -- --apply (write changes)
require('dotenv').config();

const {Client} = require('pg');

const money = value => Math.round((Number(value) || 0) * 100) / 100;

async function main() {
  const apply = process.argv.includes('--apply');
  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });

  await client.connect();
  try {
    await client.query('BEGIN');
    const {rows: notes} = await client.query(
      `SELECT invoiceid, creditnotenumber, returneditems
         FROM public.sales_return
        WHERE status = 'approved' AND invoiceid IS NOT NULL
        ORDER BY createdat ASC, id ASC`,
    );

    // Earliest credit note with an invoiceBasis, per invoice.
    const basisByInvoice = new Map();
    for (const note of notes) {
      if (basisByInvoice.has(note.invoiceid)) continue;
      const line = (note.returneditems || []).find(
        item => item && item.invoiceBasis,
      );
      if (line)
        basisByInvoice.set(note.invoiceid, {
          basis: line.invoiceBasis,
          creditNote: note.creditnotenumber,
        });
    }

    const report = [];
    let changed = 0;
    for (const [invoiceId, {basis, creditNote}] of basisByInvoice) {
      const {rows} = await client.query(
        `SELECT id, invoicenumber, isconsolidated, items, subtotal, discount, cgst, sgst, totalamount
           FROM public.invoice WHERE id::text = $1 FOR UPDATE`,
        [invoiceId],
      );
      const invoice = rows[0];
      if (!invoice) continue;

      const subtotal = money(basis.subtotal);
      const discount = money(basis.discount);
      const tax = money(basis.tax);
      const totalAmount = Math.round(Number(basis.total) || 0);
      const cgst = money(tax / 2);
      const sgst = money(tax - cgst);
      const linesTotal = money(
        (invoice.items || []).reduce(
          (sum, item) => sum + (Number(item.totalPrice) || 0),
          0,
        ),
      );

      const entry = {
        invoice: invoice.invoicenumber,
        creditNote,
        current: `${money(invoice.subtotal)} / ${money(invoice.totalamount)}`,
        original: `${subtotal} / ${totalAmount}`,
        savedLinesTotal: linesTotal,
        action: '',
      };
      if (invoice.isconsolidated) entry.action = 'skip: consolidated';
      else if (
        !(subtotal > 0) ||
        Math.round(subtotal - discount + tax) !== totalAmount
      )
        entry.action = 'skip: basis not self-consistent';
      else if (linesTotal !== subtotal)
        entry.action = 'skip: saved lines do not match basis';
      else if (
        money(invoice.subtotal) === subtotal &&
        money(invoice.discount) === discount &&
        money(invoice.cgst) === cgst &&
        money(invoice.sgst) === sgst &&
        money(invoice.totalamount) === totalAmount
      )
        entry.action = 'ok: already original';
      else {
        entry.action = apply ? 'restored' : 'would restore';
        if (apply) {
          await client.query(
            `UPDATE public.invoice
                SET subtotal = $2, discount = $3, cgst = $4, sgst = $5, totalamount = $6, updatedat = NOW()
              WHERE id = $1`,
            [invoice.id, subtotal, discount, cgst, sgst, totalAmount],
          );
        }
        changed += 1;
      }
      report.push(entry);
    }

    console.table(report);
    if (apply) {
      await client.query('COMMIT');
      console.log(`Restored ${changed} invoice(s).`);
    } else {
      await client.query('ROLLBACK');
      console.log(
        `Preview only: ${changed} invoice(s) would be restored. Re-run with --apply to write.`,
      );
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
