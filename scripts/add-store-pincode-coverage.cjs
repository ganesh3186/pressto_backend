require('dotenv').config();

const {randomUUID} = require('crypto');
const {Client} = require('pg');

// Adds one pincode to a store's serviceable area (store_pincode_coverage),
// for a pincode the client's coverage workbook missed. Pickup store
// assignment (StoreAssignmentService.resolveForPincode / listStoresForPincode)
// then treats the pincode as served by that store.
//
//   npm run coverage:add -- --store=ST039 --pincode=401107 --km=8
//
// --store   store code (e.g. ST039) or exact name (e.g. Kandivali)
// --pincode 6-digit pincode to add
// --km      approx. distance from the store to the pincode's centre; must
//           be within the pickup radius (STORE_ASSIGNMENT_RADIUS_KM, 15 km
//           by default) — a store doesn't serve a pincode beyond it
//
// Safe to re-run: does nothing when the store already covers the pincode.
// Region/cluster labels are copied from the store's existing coverage rows.

function arg(name) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : undefined;
}

async function addStorePincodeCoverage() {
  const storeArg = arg('store');
  const pincode = arg('pincode');
  const km = Number(arg('km'));
  // Same setting as the API's storeSearchRadiusKm() (src/utils/config.ts).
  const radiusSetting = [process.env.STORE_SEARCH_RADIUS_KM, process.env.STORE_ASSIGNMENT_RADIUS_KM]
    .find(value => value != null && value.trim() !== '');
  const radiusKm = radiusSetting === undefined ? 15 : Number(radiusSetting.trim());
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
    throw new Error(`STORE_SEARCH_RADIUS_KM must be a finite positive number; got "${radiusSetting}".`);
  }

  if (!storeArg) throw new Error('--store is required (store code or exact name).');
  if (!/^\d{6}$/.test(pincode ?? '')) throw new Error('--pincode must be 6 digits.');
  if (!Number.isFinite(km) || km < 0) throw new Error('--km must be a distance in km.');
  if (km > radiusKm) {
    throw new Error(`${km} km is beyond the ${radiusKm} km pickup radius — not adding.`);
  }

  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });
  await client.connect();
  try {
    const stores = await client.query(
      `SELECT id::text AS id, name, code FROM public.store
       WHERE isactive = true AND isdeleted = false AND (code = $1 OR name = $1)`,
      [storeArg],
    );
    if (stores.rowCount !== 1) {
      throw new Error(`Expected one active store for "${storeArg}", found ${stores.rowCount}.`);
    }
    const store = stores.rows[0];

    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT 1 FROM public.store_pincode_coverage
       WHERE storeid::text = $1 AND pincode = $2 AND isdeleted = false`,
      [store.id, pincode],
    );
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      console.log(`${store.name} (${store.code}) already covers ${pincode} — nothing to do.`);
      return;
    }

    const labels = await client.query(
      `SELECT region, cluster FROM public.store_pincode_coverage
       WHERE storeid::text = $1 AND isdeleted = false LIMIT 1`,
      [store.id],
    );
    await client.query(
      `INSERT INTO public.store_pincode_coverage
         (id, storeid, pincode, region, cluster, storename, centroiddistancekm,
          material, neareststore, boundarysource, isactive, isdeleted, createdat, updatedat)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $6, 'Manual (within pickup radius)', true, false, now(), now())`,
      [randomUUID(), store.id, pincode, labels.rows[0]?.region ?? null, labels.rows[0]?.cluster ?? null, store.name, km],
    );
    // Keep the per-pincode "how many stores cover it" columns consistent.
    const {rows} = await client.query(
      `UPDATE public.store_pincode_coverage
       SET storescovering = sub.n, overlap = sub.n > 1, updatedat = now()
       FROM (SELECT count(*)::int AS n FROM public.store_pincode_coverage
             WHERE pincode = $1 AND isdeleted = false AND isactive = true) sub
       WHERE pincode = $1 AND isdeleted = false
       RETURNING sub.n`,
      [pincode],
    );
    await client.query('COMMIT');
    console.log(
      `${store.name} (${store.code}) now covers ${pincode} at ~${km} km ` +
        `(${rows[0]?.n ?? 1} store(s) cover this pincode).`,
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

addStorePincodeCoverage().catch(error => {
  console.error('Could not add store pincode coverage:', error.message);
  process.exit(1);
});
