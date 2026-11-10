require('dotenv').config();

const {Client} = require('pg');

// Adds pickup_request.neareststoreid (PickupRequest.nearestStoreId) and
// backfills it for existing NOT_SERVICEABLE pickups, so each one shows in
// its nearest store's pickup list instead of every store's.
//
// 1. By distance: a pickup row keeps no coordinates, so this uses the
//    customer's saved address with the same pincode (any saved address
//    when the pickup has no pincode) and the store closest to it by
//    great-circle distance — the same measure StoreAssignmentService uses.
//    Needs coordinates on both the address and the stores.
// 2. By pincode, for whatever step 1 left empty — the same rule as
//    StoreAssignmentService.nearestStoreByPincode: the store covering (or
//    located in) the pincode sharing the longest prefix with the pickup's
//    (at least the 3-digit sorting district), then the numerically
//    closest, then the coverage centroid distance.
// Rows neither step resolves stay NULL and are visible to global admins
// only. Safe to re-run: it only fills rows that are still NULL.

function nearestByPincode(pin, candidates, activeStoreIds) {
  if (!/^\d{6}$/.test(pin)) return null;
  const sharedPrefix = other => {
    let n = 0;
    while (n < 6 && other[n] === pin[n]) n++;
    return n;
  };
  const ranked = candidates
    .filter(c => activeStoreIds.has(c.storeId))
    .map(c => ({
      storeId: c.storeId,
      prefix: sharedPrefix(c.pincode),
      gap: Math.abs(Number(c.pincode) - Number(pin)),
      km: Number.isFinite(c.km) ? c.km : Infinity,
    }))
    .filter(c => c.prefix >= 3)
    .sort((a, b) => b.prefix - a.prefix || a.gap - b.gap || a.km - b.km);
  return ranked[0]?.storeId ?? null;
}

async function addPickupNearestStore() {
  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });

  await client.connect();
  try {
    await client.query('ALTER TABLE public.pickup_request ADD COLUMN IF NOT EXISTS neareststoreid uuid');

    const byDistance = await client.query(`
      UPDATE public.pickup_request pr
      SET neareststoreid = nearest.store_id
      FROM (
        SELECT DISTINCT ON (p.id) p.id AS pickup_id, s.id AS store_id
        FROM public.pickup_request p
        JOIN public.customer_address ca
          ON ca.customerid::text = p.customerid::text
         AND ca.isdeleted = false
         AND ca.latitude IS NOT NULL AND ca.longitude IS NOT NULL
         AND NOT (ca.latitude = 0 AND ca.longitude = 0)
         AND abs(ca.latitude) <= 90 AND abs(ca.longitude) <= 180
         AND (p.pincode IS NULL OR trim(ca.pincode) = trim(p.pincode))
        JOIN public.store s
          ON s.isactive = true AND s.isdeleted = false
         AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
         AND NOT (s.latitude = 0 AND s.longitude = 0)
        WHERE p.status = 'not_serviceable'
          AND p.storeid IS NULL
          AND p.neareststoreid IS NULL
          AND p.isdeleted = false
        ORDER BY p.id,
          ca.isdefault DESC NULLS LAST,
          2 * 6371 * asin(least(1, sqrt(
            power(sin(radians(s.latitude - ca.latitude) / 2), 2) +
            cos(radians(ca.latitude)) * cos(radians(s.latitude)) *
            power(sin(radians(s.longitude - ca.longitude) / 2), 2)
          )))
      ) nearest
      WHERE pr.id = nearest.pickup_id
    `);

    const {rows: pending} = await client.query(`
      SELECT id, trim(pincode) AS pincode FROM public.pickup_request
      WHERE status = 'not_serviceable' AND storeid IS NULL AND neareststoreid IS NULL
        AND isdeleted = false AND pincode IS NOT NULL`);
    let byPincode = 0;
    if (pending.length) {
      const [{rows: coverage}, {rows: stores}] = await Promise.all([
        client.query(`SELECT storeid::text AS store_id, trim(pincode) AS pincode, centroiddistancekm AS km
                      FROM public.store_pincode_coverage WHERE isactive = true AND isdeleted = false`),
        client.query(`SELECT id::text AS id, trim(pincode) AS pincode
                      FROM public.store WHERE isactive = true AND isdeleted = false`),
      ]);
      const activeStoreIds = new Set(stores.map(s => s.id));
      const candidates = [
        ...coverage.map(r => ({storeId: r.store_id, pincode: String(r.pincode), km: Number(r.km)})),
        ...stores.map(s => ({storeId: s.id, pincode: String(s.pincode ?? ''), km: NaN})),
      ].filter(c => /^\d{6}$/.test(c.pincode));

      for (const pickup of pending) {
        const storeId = nearestByPincode(String(pickup.pincode), candidates, activeStoreIds);
        if (!storeId) continue;
        const res = await client.query(
          'UPDATE public.pickup_request SET neareststoreid = $1 WHERE id = $2 AND neareststoreid IS NULL',
          [storeId, pickup.id],
        );
        byPincode += res.rowCount;
      }
    }

    console.log(
      'pickup_request.neareststoreid is available; backfilled ' +
        `${byDistance.rowCount} not-serviceable pickup(s) by distance and ${byPincode} by pincode.`,
    );
  } finally {
    await client.end();
  }
}

addPickupNearestStore().catch(error => {
  console.error('Could not add pickup_request.neareststoreid:', error.message);
  process.exit(1);
});
