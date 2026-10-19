require('dotenv').config();

const {Client} = require('pg');

// One-off: wholesale-replaces production's item_category, service_category,
// item, service, and service_item_mapping tables with staging's exact rows
// (same ids/codes/everything) — not a name-matched merge. Deletes every
// existing row in these 5 production tables first, then clones staging's.
//
// Safe for order HISTORY display regardless (OrderItem.serviceName/itemName
// are frozen snapshots — see that migration), but any further action on an
// OLD order that re-resolves pricing against the live item/service rows
// (edit, reprocess, upgrade-service approval) will fail once this runs, if
// that order used an item/service this clone removes. Accepted trade-off,
// not a bug to fix here.
//
// Deletes child-to-parent, inserts parent-to-child, so partial failure never
// leaves a table referencing a row that was never inserted. Both databases
// are on the same Postgres instance — two plain connections, no dblink/fdw
// needed.
const TABLES = [
  {name: 'service_item_mapping', order: 'delete-first'},
  {name: 'item', order: 'delete-first'},
  {name: 'service', order: 'delete-first'},
  {name: 'item_category', order: 'delete-last'},
  {name: 'service_category', order: 'delete-last'},
];
// Delete order: children first (service_item_mapping, item, service), then
// parents (item_category, service_category). Insert order: the reverse.
const DELETE_ORDER = ['service_item_mapping', 'item', 'service', 'item_category', 'service_category'];
const INSERT_ORDER = ['item_category', 'service_category', 'item', 'service', 'service_item_mapping'];

const BATCH_SIZE = 500;

async function fetchAll(client, table) {
  const {rows} = await client.query(`SELECT * FROM public.${table}`);
  return rows;
}

async function bulkInsert(client, table, rows) {
  if (!rows.length) return 0;
  const columns = Object.keys(rows[0]);
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values = [];
    const placeholders = batch.map((row, rowIdx) => {
      const base = rowIdx * columns.length;
      const tuple = columns.map((col, colIdx) => {
        const v = row[col];
        values.push(
          v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v,
        );
        return `$${base + colIdx + 1}`;
      });
      return `(${tuple.join(', ')})`;
    });
    const sql = `INSERT INTO public.${table} (${columns.map(c => `"${c}"`).join(', ')}) VALUES ${placeholders.join(', ')}`;
    const result = await client.query(sql, values);
    inserted += result.rowCount;
  }
  return inserted;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const base = {
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
  };
  const staging = new Client({...base, database: 'pressto'});
  const prod = new Client({...base, database: 'pressto_prod'});
  await staging.connect();
  await prod.connect();

  try {
    const stagingRows = {};
    for (const t of INSERT_ORDER) {
      stagingRows[t] = await fetchAll(staging, t);
    }

    const prodCountsBefore = {};
    for (const t of DELETE_ORDER) {
      const {rows} = await prod.query(`SELECT count(*) AS n FROM public.${t}`);
      prodCountsBefore[t] = Number(rows[0].n);
    }

    console.log(apply ? 'Applying clone...' : 'Dry run (no changes made):');
    for (const t of INSERT_ORDER) {
      console.log(
        `  ${t}: production has ${prodCountsBefore[t]} row(s), ` +
          `will be deleted and replaced with ${stagingRows[t].length} row(s) from staging`,
      );
    }

    if (!apply) return;

    await prod.query('BEGIN');
    for (const t of DELETE_ORDER) {
      await prod.query(`DELETE FROM public.${t}`);
    }
    for (const t of INSERT_ORDER) {
      const inserted = await bulkInsert(prod, t, stagingRows[t]);
      console.log(`  inserted ${inserted} row(s) into ${t}`);
    }
    await prod.query('COMMIT');
    console.log('Clone applied and committed.');
  } catch (error) {
    await prod.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await staging.end();
    await prod.end();
  }
}

main().catch(error => {
  console.error('Clone failed:', error.message);
  process.exit(1);
});
