// Sets store.gstnumber from the client's GSTIN sheet
// (QSST_store_GSTIN_2026-11-12.csv). Ticket, challan, invoice and credit note
// prints refuse to render for a store without a GST number, so run this right
// after `npm run migrate:store-gst-number` on every server.
//
// Stores are matched on store.code (the sheet's Store Code). Stores missing
// from the sheet are left as they are. Only values that differ are written,
// so a second run changes nothing.
//
// Before writing, the current values of every store it changes are saved to
// store-gst-backup-<database>-<time>.json in the current folder, and
// --restore puts them back.
//
// Run from the backend folder, which picks up that environment's .env:
//   node scripts/apply-store-gst-numbers.cjs                  (preview only)
//   node scripts/apply-store-gst-numbers.cjs --apply          (saves the changes)
//   node scripts/apply-store-gst-numbers.cjs --restore=store-gst-backup-....json

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {Client} = require('pg');

// [Store Code, Store Name, GSTIN] from the client's sheet.
const SHEET = [
  ["ST002", "Bandra", "27AAECP3228Q2ZX"],
  ["ST005", "Carmichael", "27AAECP3228Q2ZX"],
  ["ST006", "Colaba", "27AAECP3228Q2ZX"],
  ["ST007", "Defence Colony", "07AAECP3228Q1Z0"],
  ["ST008", "Greater Kailash I", "07AAECP3228Q1Z0"],
  ["ST009", "Greater Kailash II", "07AAECP3228Q1Z0"],
  ["ST010", "Gurgaon", "06AAECP3228Q1Z2"],
  ["ST011", "Head office", "27AAECP3228Q2ZX"],
  ["ST012", "Malad", "27AAECP3228Q2ZX"],
  ["ST013", "Juhu Supreme", "27AAECP3228Q2ZX"],
  ["ST014", "Juhu Kalaniketan", "27AAECP3228Q2ZX"],
  ["ST016", "Lalbaug", "27AAECP3228Q2ZX"],
  ["ST018", "Nepean Sea", "27AAECP3228Q2ZX"],
  ["ST020", "PSB - Nepean Sea", "27AAECP3228Q2ZX"],
  ["ST021", "New Friends Colony", "07AAECP3228Q1Z0"],
  ["ST022", "Oshiwara", "27AAECP3228Q2ZX"],
  ["ST023", "Powai", "27AAECP3228Q2ZX"],
  ["ST024", "Prabhadevi", "27AAECP3228Q2ZX"],
  ["ST026", "Santacruz", "27AAECP3228Q2ZX"],
  ["ST027", "Vasant Vihar", "07AAECP3228Q1Z0"],
  ["ST028", "Versova", "27AAECP3228Q2ZX"],
  ["ST030", "Punjabi Bagh", "07AAECP3228Q1Z0"],
  ["ST034", "Chembur", "27AAECP3228Q2ZX"],
  ["ST035", "Casa Imperial", "27AAECP3228Q2ZX"],
  ["ST036", "Lower Parel", "27AAECP3228Q2ZX"],
  ["ST037", "Meadows", "27AAECP3228Q2ZX"],
  ["ST038", "VVIP (B2B)", "27AAECP3228Q2ZX"],
  ["ST039", "Kandivali", "27AAECP3228Q2ZX"],
  ["ST049", "Saket", "07AAECP3228Q1Z0"],
  ["ST051", "Kharghar", "27AAECP3228Q2ZX"],
  ["ST058", "Casa Ashoka Garden", "27AAECP3228Q2ZX"],
  ["ST059", "Indiranagar", "29AAECP3228Q1ZU"],
  ["ST060", "PSB Indiranagar", "29AAECP3228Q1ZU"],
  ["ST065", "Koramangala", "29AAECP3228Q1ZU"],
  ["ST066", "PSB Koramangala", "29AAECP3228Q1ZU"],
  ["ST082", "Whitefield", "29AAECP3228Q1ZU"],
  ["ST083", "PSB - Colaba", "27AAECP3228Q2ZX"],
  ["ST084", "Hibiscus", "06AAECP3228Q1Z2"],
  ["ST085", "Bestech", "06AAECP3228Q1Z2"],
  ["ST086", "Jacob Circle", "27AAECP3228Q2ZX"],
  ["ST087", "PSB - Defence Colony", "07AAECP3228Q1Z0"],
  ["ST088", "Jayanagar", "29AAECP3228Q1ZU"],
  ["ST089", "PSB - Jayanagar", "29AAECP3228Q1ZU"],
  ["ST090", "PSB - Bandra", "27AAECP3228Q2ZX"],
  ["ST091", "Sadashiv Nagar", "29AAECP3228Q1ZU"],
  ["ST092", "CR Park", "07AAECP3228Q1Z0"],
  ["ST093", "HauzKhas", "07AAECP3228Q1Z0"],
  ["ST094", "Model Town", "07AAECP3228Q1Z0"],
  ["ST095", "Banjara Hills", "36AAECP3228Q1ZZ"],
  ["ST096", "PSB - Banjara Hills", "36AAECP3228Q1ZZ"],
  ["ST097", "Goregaon", "27AAECP3228Q2ZX"],
  ["ST098", "Ville Parle", "27AAECP3228Q2ZX"],
  ["ST099", "Noida", "09AAECP3228Q2ZV"],
  ["ST103", "Hitech City", "36AAECP3228Q1ZZ"],
  ["ST105", "Hiranandani Estate", "27AAECP3228Q2ZX"],
  ["ST106", "Vasant Kunj", "07AAECP3228Q1Z0"],
  ["ST107", "Reclamation", "27AAECP3228Q2ZX"],
  ["ST108", "Richmond Circle", "29AAECP3228Q1ZU"],
  ["ST109", "Vashi", "27AAECP3228Q2ZX"],
  ["ST110", "P2Daily - Whitefield", "29AAECP3228Q1ZU"],
  ["ST112", "Rajouri Garden", "07AAECP3228Q1Z0"],
  ["ST113", "Babulnath", "27AAECP3228Q2ZX"],
  ["ST114", "Pitampura", "07AAECP3228Q1Z0"],
  ["ST115", "Panchsheel Enclave", "07AAECP3228Q1Z0"],
  ["ST116", "Naraina Vihar", "07AAECP3228Q1Z0"],
  ["ST117", "Tardeo", "27AAECP3228Q2ZX"],
  ["ST119", "HSR Layout", "29AAECP3228Q1ZU"],
  ["ST120", "ITPL", "29AAECP3228Q1ZU"],
  ["ST126", "Shastri Nagar", "27AAECP3228Q2ZX"],
  ["ST127", "Lodha Signet", "27AAECP3228Q2ZX"],
  ["ST131", "Juhu Tara", "27AAECP3228Q2ZX"],
  ["ST132", "Seawoods", "27AAECP3228Q2ZX"],
  ["ST135", "Emarald Plaza", "06AAECP3228Q1Z2"],
  ["ST137", "Dwarka", "07AAECP3228Q1Z0"],
  ["ST139", "Sohna Road", "06AAECP3228Q1Z2"],
  ["ST142", "HUDA Gurgaon", "06AAECP3228Q1Z2"],
  ["ST146", "Ambli", "24AAECP3228Q1Z4"],
  ["ST147", "PSB - Ambli", "24AAECP3228Q1Z4"],
  ["ST152", "Chandivali", "27AAECP3228Q2ZX"],
  ["ST158", "Kalyani Nagar", "27AAECP3228Q2ZX"],
  ["ST159", "Koregaon Park", "27AAECP3228Q2ZX"],
  ["ST160", "PSB Kalyani Nagar", "27AAECP3228Q2ZX"],
  ["ST999", "WebStore", "27AAECP3228Q2ZX"],
];

// Same rule as StoreController.normalizeAndValidateGstNumber.
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** GSTIN check digit (the 15th character). */
function hasValidChecksum(gstin) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = CHARS.indexOf(gstin[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(value / 36) + (value % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36] === gstin[14];
}

function parseArgs(argv) {
  const options = {apply: false, restore: null};
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg.startsWith('--restore=')) options.restore = arg.slice(10).trim();
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.restore && options.apply) throw new Error('Use --apply or --restore, not both');
  return options;
}

function checkSheet() {
  const seen = new Set();
  for (const [code, name, gstin] of SHEET) {
    if (seen.has(code)) throw new Error(`Sheet lists ${code} twice`);
    seen.add(code);
    if (!GSTIN_PATTERN.test(gstin)) throw new Error(`GSTIN for ${code} ${name} is not a valid 15-character GSTIN`);
    if (!hasValidChecksum(gstin)) throw new Error(`GSTIN for ${code} ${name} fails its check digit`);
  }
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

async function hasGstColumn(client) {
  const {rows} = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'store' AND column_name = 'gstnumber'`,
  );
  return rows.length > 0;
}

function plan(stores) {
  const byCode = new Map();
  for (const store of stores) {
    const code = String(store.code).trim().toUpperCase();
    if (byCode.has(code)) throw new Error(`Two stores use the code ${code}; fix that first`);
    byCode.set(code, store);
  }
  const changes = [];
  const unchanged = [];
  const notFound = [];
  for (const [code, sheetName, gstin] of SHEET) {
    const store = byCode.get(code);
    if (!store) {
      notFound.push(`${code} ${sheetName}`);
      continue;
    }
    const current = String(store.gstnumber ?? '').trim().toUpperCase();
    if (current === gstin) unchanged.push(store);
    else changes.push({store, gstin, current});
  }
  const sheetCodes = new Set(SHEET.map(row => row[0]));
  const activeWithout = stores.filter(
    s => s.isactive && !sheetCodes.has(String(s.code).trim().toUpperCase()) && !String(s.gstnumber ?? '').trim(),
  );
  const inactiveInSheet = stores.filter(s => !s.isactive && sheetCodes.has(String(s.code).trim().toUpperCase()));
  return {changes, unchanged, notFound, activeWithout, inactiveInSheet};
}

function printPlan(result, stores) {
  const filled = stores.filter(s => s.isactive && String(s.gstnumber ?? '').trim()).length;
  const active = stores.filter(s => s.isactive).length;
  console.log(`Sheet rows: ${SHEET.length}. Active stores with a GST number now: ${filled} of ${active}.`);

  const added = result.changes.filter(c => !c.current);
  const replaced = result.changes.filter(c => c.current);
  const byGstin = new Map();
  for (const c of added) byGstin.set(c.gstin, [...(byGstin.get(c.gstin) ?? []), c.store.code]);
  console.log(`\nGST number added (${added.length}):`);
  for (const [gstin, codes] of byGstin) console.log(`  ${gstin}: ${codes.join(', ')}`);
  if (replaced.length) {
    console.log(`\nGST number replaced (${replaced.length}):`);
    for (const c of replaced) console.log(`  ${c.store.code} ${c.store.name}: ${c.current} -> ${c.gstin}`);
  }
  console.log(`\nAlready correct: ${result.unchanged.length}`);
  if (result.notFound.length) console.log(`\nIn the sheet but no store with that code (skipped): ${result.notFound.join(', ')}`);
  if (result.inactiveInSheet.length) {
    console.log(`\nInactive stores in the sheet (still updated): ${result.inactiveInSheet.map(s => `${s.code} ${s.name}`).join(', ')}`);
  }
  if (result.activeWithout.length) {
    console.log(
      `\nActive stores still without a GST number (printing will fail there): ` +
        result.activeWithout.map(s => `${s.code} ${s.name}`).join(', '),
    );
  }
  console.log(`\nStores to update: ${result.changes.length}`);
}

async function applyChanges(client, changes) {
  const database = process.env.PG_DATABASE;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.resolve(`store-gst-backup-${database}-${stamp}.json`);
  const backup = changes.map(({store}) => ({id: store.id, code: store.code, gstnumber: store.gstnumber ?? null}));
  fs.writeFileSync(backupFile, JSON.stringify({database, savedAt: new Date().toISOString(), stores: backup}, null, 2));
  console.log(`\nBackup of the current values: ${backupFile}`);

  await client.query('BEGIN');
  try {
    for (const c of changes) {
      await client.query('UPDATE public.store SET gstnumber = $1, updatedat = NOW() WHERE id = $2', [
        c.gstin,
        c.store.id,
      ]);
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
      await client.query('UPDATE public.store SET gstnumber = $1, updatedat = NOW() WHERE id = $2', [
        store.gstnumber,
        store.id,
      ]);
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
    if (!(await hasGstColumn(client))) {
      throw new Error('store.gstnumber does not exist yet. Run `npm run migrate:store-gst-number` first.');
    }
    if (options.restore) {
      await restore(client, options.restore);
      return;
    }

    const {rows: stores} = await client.query(
      `SELECT id, code, name, gstnumber, isactive
         FROM public.store
        WHERE COALESCE(isdeleted, false) = false
        ORDER BY code`,
    );
    const result = plan(stores);
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
