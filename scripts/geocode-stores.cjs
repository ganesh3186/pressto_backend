require('dotenv').config();

const https = require('https');
const {Client} = require('pg');

// Fills in latitude/longitude for active stores that have none, by
// geocoding each store's address with the Google Geocoding API — the same
// API GeocodingService uses for customer addresses. Store coordinates are
// what make pickup store assignment distance-based:
//   - nearest store within STORE_ASSIGNMENT_RADIUS_KM (15 km) → serviceable
//   - otherwise not serviceable, shown only to the closest store (any distance)
// Without them, only the pincode coverage table can match a store.
//
//   npm run stores:geocode            # dry run: prints what it would save
//   npm run stores:geocode -- --apply # saves the coordinates
//
// Needs GOOGLE_GEOCODING_API_KEY. Only touches stores with no coordinates
// (NULL or 0,0), and skips any result outside India or not from Google's
// exact/interpolated address match, so a vague match never gets saved.

const INDIA = {minLat: 6, maxLat: 37.5, minLng: 68, maxLng: 97.5};

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error('Geocoding request timed out')));
    req.on('error', reject);
  });
}

async function geocode(text, key) {
  const url =
    'https://maps.googleapis.com/maps/api/geocode/json?region=in&address=' +
    encodeURIComponent(text) +
    '&key=' +
    key;
  const body = await getJson(url);
  if (body.status !== 'OK' || !body.results?.length) return {error: body.status || 'NO_RESULT'};
  const top = body.results[0];
  const {lat, lng} = top.geometry.location;
  return {
    latitude: lat,
    longitude: lng,
    precision: top.geometry.location_type,
    partial: Boolean(top.partial_match),
    formatted: top.formatted_address,
  };
}

async function geocodeStores() {
  const apply = process.argv.includes('--apply');
  const key = process.env.GOOGLE_GEOCODING_API_KEY?.trim();
  if (!key) throw new Error('GOOGLE_GEOCODING_API_KEY is not set.');

  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });
  await client.connect();
  try {
    const {rows: stores} = await client.query(`
      SELECT id, name, code, address, city, state, pincode FROM public.store
      WHERE isactive = true AND isdeleted = false
        AND (latitude IS NULL OR longitude IS NULL OR (latitude = 0 AND longitude = 0))
      ORDER BY name`);
    console.log(`${stores.length} active store(s) without coordinates.${apply ? '' : ' Dry run — nothing is saved.'}\n`);

    let saved = 0;
    let skipped = 0;
    for (const store of stores) {
      const text = [store.address, store.city, store.state, store.pincode, 'India']
        .map(part => String(part ?? '').trim())
        .filter(Boolean)
        .join(', ');
      const result = await geocode(text, key).catch(error => ({error: error.message}));
      const label = `${store.name} (${store.code})`.padEnd(34);

      if (result.error) {
        console.log(`  SKIP ${label} ${result.error}`);
        skipped++;
        continue;
      }
      const inIndia =
        result.latitude >= INDIA.minLat && result.latitude <= INDIA.maxLat &&
        result.longitude >= INDIA.minLng && result.longitude <= INDIA.maxLng;
      // APPROXIMATE / GEOMETRIC_CENTER results are a city or area centre, not
      // the shop — too coarse to decide a 15 km radius from.
      const precise = result.precision === 'ROOFTOP' || result.precision === 'RANGE_INTERPOLATED';
      if (!inIndia || !precise) {
        console.log(`  SKIP ${label} ${result.precision}${inIndia ? '' : ', outside India'} — ${result.formatted}`);
        skipped++;
        continue;
      }

      console.log(
        `  ${apply ? 'SAVE' : 'OK  '} ${label} ${result.latitude.toFixed(6)}, ${result.longitude.toFixed(6)}` +
          `${result.partial ? ' (partial match)' : ''} — ${result.formatted}`,
      );
      if (apply) {
        await client.query(
          `UPDATE public.store SET latitude = $1, longitude = $2, updatedat = now()
           WHERE id = $3 AND (latitude IS NULL OR longitude IS NULL OR (latitude = 0 AND longitude = 0))`,
          [result.latitude, result.longitude, store.id],
        );
        saved++;
      }
      // Stay well under Google's per-second quota.
      await new Promise(resolve => setTimeout(resolve, 120));
    }

    console.log(
      `\n${apply ? `Saved ${saved}` : `Would save ${stores.length - skipped}`}, skipped ${skipped}. ` +
        (skipped ? 'Set skipped stores by hand in the admin panel (Store master).' : ''),
    );
  } finally {
    await client.end();
  }
}

geocodeStores().catch(error => {
  console.error('Could not geocode stores:', error.message);
  process.exit(1);
});
