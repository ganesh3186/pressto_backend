// Creates the regional price lists from regional_masters (workbooks 2-6, built
// 2026-11-09) as price-override coupons, one per workbook, each targeted at
// that workbook's stores. Base prices (service_item_mapping) are never
// written: a price-override coupon is applied automatically whenever a store
// is priced (OrderService.resolvePricing, GET /service-item-prices), so the
// stores in a workbook bill its prices and every other store stays on base.
//
// Data: scripts/data/regional-price-coupons.json, generated from the
// workbooks, matched here by service name + item name. A coupon only gets the
// rows whose regional price differs from this database's base price, unless a
// store/cluster/region percentage would otherwise apply to its stores; then
// it gets every row, so the workbook price wins everywhere.
//
// Courier and packing add-ons (Add Ons Master) are additional charges, which
// a coupon cannot price; they are not touched.
//
// Re-running is safe: coupons are found by code and their rows brought in
// line with the data (new rows added, changed prices updated, rows no longer
// needed soft-deleted).
//
// Run from the backend folder, which picks up that environment's .env:
//   node scripts/apply-regional-price-coupons.cjs                (preview only)
//   node scripts/apply-regional-price-coupons.cjs --apply        (create / update the coupons)
//   node scripts/apply-regional-price-coupons.cjs --deactivate   (switch them off: back to base prices)
//   add --only=REGIONAL-PDC-DOWN05-BLR to work on one coupon

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {Client} = require('pg');

const DATA = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'regional-price-coupons.json'), 'utf8'),
);
const START_DATE = '2026-11-01';
const END_DATE = '2099-12-31';
const BATCH = 5000;

const norm = s =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ');

function parseArgs(argv) {
  const options = {apply: false, deactivate: false, only: null};
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--deactivate') options.deactivate = true;
    else if (arg.startsWith('--only=')) options.only = arg.slice(7).trim().toUpperCase();
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.apply && options.deactivate) throw new Error('Use --apply or --deactivate, not both');
  return options;
}

function connect() {
  return new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });
}

/** Active rows by normalised name; a name used twice can't be matched safely. */
function idsByName(rows, label) {
  const byName = new Map();
  const duplicates = new Set();
  for (const row of rows) {
    const key = norm(row.name);
    if (byName.has(key)) duplicates.add(row.name);
    byName.set(key, row.id);
  }
  for (const name of duplicates) byName.delete(norm(name));
  if (duplicates.size) console.log(`  ${label} names used twice, skipped: ${[...duplicates].join(', ')}`);
  return byName;
}

async function loadDatabase(client, codes) {
  const q = async (sql, params) => (await client.query(sql, params)).rows;
  const [stores, services, items, mappings, clusters, storePct, clusterPct, regionPct, coupons, uniqueIndex] =
    await Promise.all([
      q(`SELECT id, code, name, clusterid, isactive FROM public.store WHERE COALESCE(isdeleted, false) = false`),
      q(`SELECT id, name FROM public.service WHERE COALESCE(isdeleted, false) = false`),
      q(`SELECT id, name FROM public.item WHERE COALESCE(isdeleted, false) = false`),
      q(`SELECT serviceid, itemid, baseprice FROM public.service_item_mapping WHERE COALESCE(isdeleted, false) = false`),
      q(`SELECT id, regionid FROM public.cluster`),
      q(`SELECT storeid AS id, percentage FROM public.store_price_override
          WHERE isactive = true AND COALESCE(isdeleted, false) = false AND percentage IS NOT NULL`),
      q(`SELECT clusterid AS id, percentage FROM public.cluster_price_list
          WHERE isactive = true AND COALESCE(isdeleted, false) = false AND percentage IS NOT NULL`),
      q(`SELECT regionid AS id, percentage FROM public.price_list
          WHERE isactive = true AND COALESCE(isdeleted, false) = false AND percentage IS NOT NULL`),
      q(`SELECT id, code, name, discounttype, isactive, isdeleted FROM public.coupon
          WHERE discounttype = 'price_override' OR UPPER(code) = ANY($1)`, [codes]),
      q(`SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'coupon_price_override'
          AND indexdef ILIKE 'CREATE UNIQUE INDEX%(couponid, serviceid, itemid)%'`),
    ]);
  const ours = coupons.filter(c => codes.includes(String(c.code).toUpperCase()));
  const rows = ours.length
    ? await q(
        `SELECT id, couponid, serviceid, itemid, overrideprice, isactive, isdeleted
           FROM public.coupon_price_override WHERE couponid = ANY($1::uuid[])`,
        [ours.map(c => c.id)],
      )
    : [];
  return {
    stores, services, items, mappings, clusters, coupons, rows,
    storePct: new Map(storePct.map(r => [r.id, r.percentage])),
    clusterPct: new Map(clusterPct.map(r => [r.id, r.percentage])),
    regionPct: new Map(regionPct.map(r => [r.id, r.percentage])),
    hasUniqueIndex: uniqueIndex.length > 0,
  };
}

/** What each coupon should hold in this database, and what that changes. */
function plan(db, specs) {
  const serviceId = idsByName(db.services, 'Service');
  const itemId = idsByName(db.items, 'Item');
  const basePrice = new Map(db.mappings.map(m => [`${m.serviceid}:${m.itemid}`, Number(m.baseprice)]));
  const storeByCode = new Map(db.stores.map(s => [String(s.code).trim().toUpperCase(), s]));
  const regionOfCluster = new Map(db.clusters.map(c => [c.id, c.regionid]));
  const resolve = ([s, i]) => {
    const sid = serviceId.get(norm(DATA.services[s]));
    const iid = itemId.get(norm(DATA.items[i]));
    return sid && iid ? `${sid}:${iid}` : null;
  };

  // Our base should already equal the workbook's base: report any difference.
  const baseDiffs = [];
  for (const row of DATA.basePriceCheck) {
    const key = resolve(row);
    const current = key ? basePrice.get(key) : undefined;
    if (current !== undefined && current !== row[2]) {
      baseDiffs.push(`${DATA.services[row[0]]} / ${DATA.items[row[1]]}: DB ${current}, workbook ${row[2]}`);
    }
  }

  return {
    baseDiffs,
    coupons: specs.map(spec => {
      const stores = [];
      const missingStores = [];
      const percentageStores = [];
      for (const code of spec.storeCodes) {
        const store = storeByCode.get(code);
        if (!store) {
          missingStores.push(code);
          continue;
        }
        stores.push(store);
        const pct =
          db.storePct.get(store.id) ??
          db.clusterPct.get(store.clusterid) ??
          db.regionPct.get(regionOfCluster.get(store.clusterid));
        if (pct != null && Number(pct) !== 0) percentageStores.push(`${code} (${pct}%)`);
      }
      const allRows = percentageStores.length > 0;

      const desired = new Map();
      const unmatched = [];
      let noMapping = 0;
      for (const row of spec.prices) {
        const key = resolve(row);
        if (!key) {
          unmatched.push(`${DATA.services[row[0]]} / ${DATA.items[row[1]]}`);
          continue;
        }
        const base = basePrice.get(key);
        if (base === undefined) {
          noMapping++;
          continue;
        }
        if (allRows || base !== row[2]) desired.set(key, row[2]);
      }

      const coupon = db.coupons.find(c => String(c.code).toUpperCase() === spec.code) ?? null;
      const existing = new Map(
        db.rows.filter(r => coupon && r.couponid === coupon.id).map(r => [`${r.serviceid}:${r.itemid}`, r]),
      );
      let added = 0;
      let changed = 0;
      let unchanged = 0;
      for (const [key, price] of desired) {
        const row = existing.get(key);
        if (!row) added++;
        else if (Number(row.overrideprice) !== price || !row.isactive || row.isdeleted) changed++;
        else unchanged++;
      }
      const removed = [...existing]
        .filter(([key, row]) => !desired.has(key) && row.isactive && !row.isdeleted)
        .map(([, row]) => row.id);

      return {spec, coupon, stores, missingStores, percentageStores, allRows, desired, unmatched, noMapping,
        added, changed, unchanged, removed};
    }),
  };
}

function printPlan(result, db, specs) {
  const codes = specs.map(s => s.code);
  const others = db.coupons.filter(
    c => c.discounttype === 'price_override' && c.isactive && !c.isdeleted && !codes.includes(String(c.code).toUpperCase()),
  );
  if (others.length) {
    console.log(`\nOther active price-override coupons (the cheaper price wins where they overlap): ${others.map(c => c.code).join(', ')}`);
  }
  if (result.baseDiffs.length) {
    console.log(`\nBase prices that differ from the workbook base (${result.baseDiffs.length}); coupons still set the regional price:`);
    for (const line of result.baseDiffs.slice(0, 15)) console.log(`  ${line}`);
    if (result.baseDiffs.length > 15) console.log(`  ... and ${result.baseDiffs.length - 15} more`);
  }
  if (!db.hasUniqueIndex) console.log('\nWARNING: the unique (couponid, serviceid, itemid) index is missing; --apply will refuse to run.');

  for (const c of result.coupons) {
    console.log(`\n${c.spec.code}  ${c.coupon ? '(exists)' : '(new)'}  ${c.spec.name}`);
    if (c.coupon && c.coupon.discounttype !== 'price_override') {
      console.log(`  ERROR: code already used by a ${c.coupon.discounttype} coupon`);
    }
    const inactive = c.stores.filter(s => !s.isactive).map(s => s.code);
    console.log(`  Stores: ${c.stores.length} of ${c.spec.storeCodes.length}` +
      (inactive.length ? ` (inactive: ${inactive.join(', ')})` : ''));
    if (c.missingStores.length) console.log(`  Store codes not found: ${c.missingStores.join(', ')}`);
    if (c.allRows) console.log(`  Percentage pricing on ${c.percentageStores.join(', ')}: every row is included`);
    console.log(`  Price rows: ${c.desired.size} (new ${c.added}, changed ${c.changed}, unchanged ${c.unchanged}, removed ${c.removed.length})`);
    if (c.noMapping) console.log(`  Rows with no service-item mapping here (skipped): ${c.noMapping}`);
    if (c.unmatched.length) {
      console.log(`  Rows whose service or item name isn't in this database (skipped): ${c.unmatched.length}`);
      for (const line of c.unmatched.slice(0, 10)) console.log(`    ${line}`);
    }
  }
}

async function upsertCoupon(client, c) {
  const values = [
    c.spec.name,
    c.spec.description,
    JSON.stringify(c.stores.map(s => s.id)),
    END_DATE,
  ];
  if (c.coupon) {
    await client.query(
      `UPDATE public.coupon
          SET name = $1, description = $2, storeids = $3::jsonb, enddate = $4,
              discounttype = 'price_override', discountvalue = 0,
              clusterids = NULL, regionids = NULL, customerlabelids = NULL,
              hidefromticketlist = true, isactive = true, isdeleted = false, deletedat = NULL,
              updatedat = NOW()
        WHERE id = $5`,
      [...values, c.coupon.id],
    );
    return c.coupon.id;
  }
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO public.coupon
       (id, code, name, description, discounttype, discountvalue, startdate, enddate, storeids,
        isreferralcode, hidefromticketlist, totalusescount, isactive, isdeleted, createdat, updatedat)
     VALUES ($6, $5, $1, $2, 'price_override', 0, $7, $4, $3::jsonb,
        false, true, 0, true, false, NOW(), NOW())`,
    [...values, c.spec.code, id, START_DATE],
  );
  return id;
}

async function writeRows(client, couponId, c) {
  const entries = [...c.desired];
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    await client.query(
      `INSERT INTO public.coupon_price_override
         (id, couponid, serviceid, itemid, overrideprice, isactive, isdeleted, createdat, updatedat)
       SELECT id, $2::uuid, serviceid, itemid, price, true, false, NOW(), NOW()
         FROM unnest($1::uuid[], $3::uuid[], $4::uuid[], $5::numeric[]) AS t(id, serviceid, itemid, price)
       ON CONFLICT (couponid, serviceid, itemid) DO UPDATE
         SET overrideprice = EXCLUDED.overrideprice, isactive = true, isdeleted = false,
             deletedat = NULL, updatedat = NOW()
         WHERE coupon_price_override.overrideprice IS DISTINCT FROM EXCLUDED.overrideprice
            OR coupon_price_override.isactive IS DISTINCT FROM true
            OR coupon_price_override.isdeleted IS DISTINCT FROM false`,
      [
        batch.map(() => crypto.randomUUID()),
        couponId,
        batch.map(([key]) => key.split(':')[0]),
        batch.map(([key]) => key.split(':')[1]),
        batch.map(([, price]) => price),
      ],
    );
  }
  if (c.removed.length) {
    await client.query(
      `UPDATE public.coupon_price_override
          SET isdeleted = true, deletedat = NOW(), updatedat = NOW()
        WHERE id = ANY($1::uuid[])`,
      [c.removed],
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const specs = DATA.coupons.filter(c => !options.only || c.code === options.only);
  if (!specs.length) throw new Error(`No coupon with code ${options.only} in the data file`);
  const codes = specs.map(s => s.code);

  const client = connect();
  await client.connect();
  try {
    console.log(`Database: ${process.env.PG_DATABASE} on ${process.env.PG_HOST}`);

    if (options.deactivate) {
      const {rowCount} = await client.query(
        `UPDATE public.coupon SET isactive = false, updatedat = NOW()
          WHERE UPPER(code) = ANY($1) AND discounttype = 'price_override' AND isactive = true`,
        [codes],
      );
      console.log(`Switched off ${rowCount} coupon(s); those stores are back on base prices.`);
      return;
    }

    const db = await loadDatabase(client, codes);
    const result = plan(db, specs);
    printPlan(result, db, specs);

    if (!options.apply) {
      console.log('\nPreview only. Run again with --apply to save.');
      return;
    }
    if (!db.hasUniqueIndex) throw new Error('Unique (couponid, serviceid, itemid) index missing on coupon_price_override');
    const clash = result.coupons.find(c => c.coupon && c.coupon.discounttype !== 'price_override');
    if (clash) throw new Error(`Code ${clash.spec.code} is already used by a ${clash.coupon.discounttype} coupon`);

    await client.query('BEGIN');
    try {
      for (const c of result.coupons) {
        const couponId = await upsertCoupon(client, c);
        await writeRows(client, couponId, c);
        console.log(`Saved ${c.spec.code}: ${c.desired.size} price rows for ${c.stores.length} stores.`);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    console.log('Done. Base prices were not changed.');
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
