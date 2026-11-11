// Sets store latitude, longitude and pincode from the client's store sheet
// (Pressto_Store_Master_LatLong.xlsx, received 11 Nov 2026). The sheet is the
// source of truth: it replaces coordinates we filled earlier from Google.
//
// Stores are matched on store.code (the sheet's StoreID). Stores missing from
// the sheet are left as they are. Only values that differ are written, so a
// second run changes nothing.
//
// Before writing, the current values of every store it changes are saved to
// store-coordinates-backup-<database>-<time>.json in the current folder, and
// --restore puts them back.
//
// Run from the backend folder, which picks up that environment's .env:
//   node scripts/apply-client-store-coordinates.cjs                  (preview only)
//   node scripts/apply-client-store-coordinates.cjs --apply          (saves the changes)
//   node scripts/apply-client-store-coordinates.cjs --apply --skip-pincodes
//   node scripts/apply-client-store-coordinates.cjs --restore=store-coordinates-backup-....json

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {Client} = require('pg');

// [StoreID, StoreName, Pincode, Latitude, Longitude] from the client's sheet.
const SHEET = [
  ['ST059', 'Indiranagar', '560075', 12.977377, 77.647419],
  ['ST065', 'Koramangala', '560034', 12.933212, 77.634544],
  ['ST082', 'Whitefield', '560048', 12.95737, 77.736245],
  ['ST119', 'HSR Layout', '560102', 12.913839, 77.648941],
  ['ST120', 'ITPL', '560048', 12.988704, 77.729872],
  ['ST088', 'Jayanagar', '560011', 12.924638, 77.584991],
  ['ST091', 'Sadashiv Nagar', '560080', 13.007356, 77.579374],
  ['ST108', 'Richmond Circle', '560027', 12.965042, 77.596462],
  ['ST060', 'PSB Indiranagar', '560075', 12.977502, 77.646732],
  ['ST066', 'PSB Koramangala', '560034', 12.933003, 77.634373],
  ['ST089', 'PSB - Jayanagar', '560011', 12.927398, 77.585149],
  ['ST095', 'Banjara Hills', '500034', 17.412931, 78.438484],
  ['ST103', 'Hitech City', '500104', 17.429679, 78.378139],
  ['ST096', 'PSB - Banjara Hills', '500034', 17.409471, 78.438348],
  ['ST012', 'Malad', '400064', 19.182706, 72.836351],
  ['ST039', 'Kandivali', '400101', 19.211055, 72.875679],
  ['ST097', 'Goregaon', '400063', 19.174661, 72.86352],
  ['ST005', 'Carmichael', '400026', 18.972391, 72.810058],
  ['ST006', 'Colaba', '400005', 18.917399, 72.824257],
  ['ST016', 'Lalbaug', '400012', 18.996178, 72.837056],
  ['ST018', 'Nepean Sea', '400036', 18.962549, 72.801354],
  ['ST026', 'Santacruz', '400054', 19.078054, 72.834401],
  ['ST035', 'Casa Imperial', '400007', 18.972453, 72.813028],
  ['ST036', 'Lower Parel', '400013', 18.993468, 72.832022],
  ['ST058', 'Casa Ashoka Garden', '400015', 18.995533, 72.847842],
  ['ST086', 'Jacob Circle', '400011', 18.98056, 72.826882],
  ['ST113', 'Babulnath', '400007', 18.956248, 72.808249],
  ['ST117', 'Tardeo', '400007', 18.966422, 72.8109],
  ['ST127', 'Lodha Signet', '400013', 19.003422, 72.829306],
  ['ST023', 'Powai', '400076', 19.120727, 72.909247],
  ['ST034', 'Chembur', '400074', 19.049566, 72.905865],
  ['ST037', 'Meadows', '400610', 19.227047, 72.970336],
  ['ST051', 'Kharghar', '410210', 19.035076, 73.065182],
  ['ST105', 'Hiranandani Estate', '400607', 19.258993, 72.982782],
  ['ST109', 'Vashi', '400703', 19.072404, 72.999453],
  ['ST132', 'Seawoods', '400703', 19.01311, 73.013045],
  ['ST152', 'Chandivali', '400076', 19.117019, 72.903628],
  ['ST020', 'PSB - Nepean Sea', '400036', 18.967744, 72.801676],
  ['ST083', 'PSB - Colaba', '400005', 18.92212, 72.824335],
  ['ST090', 'PSB - Bandra', '400050', 19.059755, 72.836555],
  ['ST002', 'Bandra', '400050', 19.065382, 72.829652],
  ['ST024', 'Prabhadevi', '400018', 19.013976, 72.829102],
  ['ST107', 'Reclamation', '400050', 19.050758, 72.826687],
  ['ST013', 'Juhu Supreme', '400049', 19.116847, 72.834334],
  ['ST014', 'Juhu Kalaniketan', '400049', 19.103695, 72.831254],
  ['ST022', 'Oshiwara', '400053', 19.153631, 72.82858],
  ['ST028', 'Versova', '400061', 19.13112, 72.815731],
  ['ST098', 'Ville Parle', '400057', 19.099009, 72.850037],
  ['ST126', 'Shastri Nagar', '400053', 19.137092, 72.829463],
  ['ST131', 'Juhu Tara', '400049', 19.092811, 72.828189],
  ['ST007', 'Defence Colony', '110024', 28.573617, 77.228728],
  ['ST021', 'New Friends Colony', '110065', 28.569127, 77.268231],
  ['ST027', 'Vasant Vihar', '110057', 28.571407, 77.158527],
  ['ST099', 'Noida', '201301', 28.573018, 77.32207],
  ['ST106', 'Vasant Kunj', '110070', 28.540422, 77.152176],
  ['ST010', 'Gurgaon', '122002', 28.443367, 77.100862],
  ['ST084', 'Hibiscus', '122002', 28.423418, 77.057539],
  ['ST085', 'Bestech', '122002', 28.468688, 77.074547],
  ['ST135', 'Emarald Plaza', '122102', 28.406135, 77.068295],
  ['ST139', 'Sohna Road', '122002', 28.417989, 77.040953],
  ['ST142', 'HUDA Gurgaon', '122001', 28.458211, 77.044589],
  ['ST087', 'PSB - Defence Colony', '110024', 28.573617, 77.228728],
  ['ST030', 'Punjabi Bagh', '110026', 28.66643, 77.127435],
  ['ST094', 'Model Town', '110009', 28.707732, 77.182664],
  ['ST112', 'Rajouri Garden', '110027', 28.639158, 77.115256],
  ['ST114', 'Pitampura', '110088', 28.703916, 77.131594],
  ['ST116', 'Naraina Vihar', '110028', 28.624236, 77.140909],
  ['ST137', 'Dwarka', '110078', 28.593029, 77.046132],
  ['ST008', 'Greater Kailash I', '110048', 28.551449, 77.236772],
  ['ST009', 'Greater Kailash II', '110048', 28.532507, 77.245463],
  ['ST049', 'Saket', '110017', 28.524218, 77.207311],
  ['ST092', 'CR Park', '110019', 28.541642, 77.247981],
  ['ST093', 'HauzKhas', '110030', 28.551815, 77.205508],
  ['ST115', 'Panchsheel Enclave', '110017', 28.544524, 77.230066],
  ['ST146', 'Ambli', '380015', 23.027309, 72.506466],
  ['ST147', 'PSB - Ambli', '380015', 23.027309, 72.506466],
  ['ST158', 'Kalyani Nagar', '411006', 18.547601, 73.90039],
  ['ST159', 'Koregaon Park', '411001', 18.53926, 73.898248],
  ['ST160', 'PSB Kalyani Nagar', '411006', 18.547601, 73.90039],
];

const INDIA = {minLat: 6, maxLat: 38, minLng: 68, maxLng: 98};

function parseArgs(argv) {
  const options = {apply: false, skipPincodes: false, restore: null};
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--skip-pincodes') options.skipPincodes = true;
    else if (arg.startsWith('--restore=')) options.restore = arg.slice(10).trim();
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.restore && options.apply) throw new Error('Use --apply or --restore, not both');
  return options;
}

function checkSheet() {
  const seen = new Set();
  for (const [code, name, pincode, lat, lng] of SHEET) {
    if (seen.has(code)) throw new Error(`Sheet lists ${code} twice`);
    seen.add(code);
    if (!/^\d{6}$/.test(pincode)) throw new Error(`Sheet pincode for ${code} ${name} is not 6 digits`);
    if (!(lat >= INDIA.minLat && lat <= INDIA.maxLat && lng >= INDIA.minLng && lng <= INDIA.maxLng)) {
      throw new Error(`Sheet location for ${code} ${name} is outside India`);
    }
  }
}

function km(lat1, lng1, lat2, lng2) {
  const rad = d => (d * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

function hasCoordinates(store) {
  const lat = Number(store.latitude);
  const lng = Number(store.longitude);
  return store.latitude != null && store.longitude != null && !(lat === 0 && lng === 0);
}

function sameNumber(current, next) {
  return current != null && Number(current).toFixed(6) === Number(next).toFixed(6);
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

/** Works out what each sheet row would change. */
function plan(stores, options) {
  const byCode = new Map();
  for (const store of stores) {
    const code = String(store.code).trim();
    if (byCode.has(code)) throw new Error(`Two stores use the code ${code}; fix that first`);
    byCode.set(code, store);
  }

  const changes = [];
  const notFound = [];
  for (const [code, sheetName, pincode, latitude, longitude] of SHEET) {
    const store = byCode.get(code);
    if (!store) {
      notFound.push(`${code} ${sheetName}`);
      continue;
    }
    const coordinatesChange =
      !sameNumber(store.latitude, latitude) || !sameNumber(store.longitude, longitude);
    const pincodeChange = !options.skipPincodes && String(store.pincode ?? '').trim() !== pincode;
    if (!coordinatesChange && !pincodeChange) continue;
    changes.push({
      store,
      latitude,
      longitude,
      pincode: options.skipPincodes ? String(store.pincode ?? '').trim() : pincode,
      coordinatesChange,
      pincodeChange,
      movedKm: hasCoordinates(store)
        ? km(Number(store.latitude), Number(store.longitude), latitude, longitude)
        : null,
    });
  }

  const sheetCodes = new Set(SHEET.map(row => row[0]));
  const notInSheet = stores
    .filter(store => store.isactive && !sheetCodes.has(String(store.code).trim()))
    .map(store => `${store.code} ${store.name}`);

  return {changes, notFound, notInSheet};
}

function printPlan({changes, notFound, notInSheet}, stores) {
  const added = changes.filter(c => c.coordinatesChange && c.movedKm == null);
  const moved = changes.filter(c => c.coordinatesChange && c.movedKm != null);
  const pincodes = changes.filter(c => c.pincodeChange);
  const withCoordinates = stores.filter(s => s.isactive && hasCoordinates(s)).length;

  console.log(`Sheet rows: ${SHEET.length}. Active stores with coordinates now: ${withCoordinates}.`);
  console.log(`\nCoordinates added for the first time (${added.length}):`);
  for (const c of added) console.log(`  ${c.store.code} ${c.store.name} -> ${c.latitude}, ${c.longitude}`);

  console.log(`\nCoordinates replaced (${moved.length}), largest move first:`);
  for (const c of [...moved].sort((a, b) => b.movedKm - a.movedKm)) {
    console.log(`  ${c.store.code} ${c.store.name}: moves ${c.movedKm.toFixed(2)} km`);
  }

  console.log(`\nPincodes changed (${pincodes.length}):`);
  for (const c of pincodes) console.log(`  ${c.store.code} ${c.store.name}: ${c.store.pincode} -> ${c.pincode}`);

  if (notFound.length) console.log(`\nIn the sheet but no store with that code (skipped): ${notFound.join(', ')}`);
  if (notInSheet.length) console.log(`\nActive stores not in the sheet (left as they are): ${notInSheet.join(', ')}`);
  console.log(`\nStores to update: ${changes.length}`);
}

async function applyChanges(client, changes) {
  const database = process.env.PG_DATABASE;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.resolve(`store-coordinates-backup-${database}-${stamp}.json`);
  const backup = changes.map(({store}) => ({
    id: store.id,
    code: store.code,
    latitude: store.latitude,
    longitude: store.longitude,
    pincode: store.pincode,
  }));
  fs.writeFileSync(backupFile, JSON.stringify({database, savedAt: new Date().toISOString(), stores: backup}, null, 2));
  console.log(`\nBackup of the current values: ${backupFile}`);

  await client.query('BEGIN');
  try {
    for (const c of changes) {
      await client.query(
        `UPDATE public.store
           SET latitude = $1, longitude = $2, pincode = $3, updatedat = NOW()
         WHERE id = $4`,
        [c.latitude, c.longitude, c.pincode, c.store.id],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  console.log(`Updated ${changes.length} stores.`);
}

async function restore(client, file) {
  const backup = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (backup.database !== process.env.PG_DATABASE) {
    throw new Error(`That backup is from ${backup.database}, but this .env points at ${process.env.PG_DATABASE}`);
  }
  await client.query('BEGIN');
  try {
    for (const store of backup.stores) {
      await client.query(
        `UPDATE public.store
           SET latitude = $1, longitude = $2, pincode = $3, updatedat = NOW()
         WHERE id = $4`,
        [store.latitude, store.longitude, store.pincode, store.id],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  console.log(`Restored ${backup.stores.length} stores from ${file}.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  checkSheet();

  const client = connect();
  await client.connect();
  try {
    console.log(`Database: ${process.env.PG_DATABASE} on ${process.env.PG_HOST}`);
    if (options.restore) {
      await restore(client, options.restore);
      return;
    }

    const {rows: stores} = await client.query(
      `SELECT id, code, name, pincode, latitude, longitude, isactive
         FROM public.store
        WHERE COALESCE(isdeleted, false) = false
        ORDER BY code`,
    );
    const result = plan(stores, options);
    printPlan(result, stores);

    if (!options.apply) {
      console.log('\nPreview only. Run again with --apply to save.');
      return;
    }
    if (!result.changes.length) {
      console.log('\nNothing to change.');
      return;
    }
    await applyChanges(client, result.changes);
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
