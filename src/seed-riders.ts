import fs from 'fs';
import path from 'path';
import {presstoBackendApplication} from './application';
import {RiderType} from './models/rider-type.enum';
import {BcryptHasher} from './services/hash.password.bcrypt';
import * as Repos from './repositories';

/**
 * Rider roster reseeder (`riders.json`, produced by
 * scripts/migrate-riders.cjs from Rider_Master_List _Pulse.xlsx).
 *
 *   npm run seed:riders
 *
 * ADDITIVE only — never deletes/clears anything. Rider identity is
 * matched by phone (the Users table's real unique key): an existing
 * rider is left alone (no field overwrites) and only gains any NEW
 * RiderPincodeMapping rows this run derives for them; a rider not seen
 * before is created fresh with the default password 'pressto123'
 * (same convention the client's own Users & Roles workbook uses).
 *
 * Store-name -> real Store resolution is a hand-verified alias table
 * (STORE_NAME_ALIASES below) — the workbook's free-text store names have
 * enough typos/PSB-position variants that a generic fuzzy match isn't
 * safe to trust unsupervised; every entry here was checked by hand
 * against the actual Store rows. Anything not in the table falls back to
 * an exact normalized-name match (handles a future rerun naming a store
 * that didn't exist yet), then is logged unresolved rather than guessed.
 *
 * Once a rider's covered stores are resolved, each store's pincode
 * coverage (Store×Pincode, seeded separately — see
 * seed-cluster-pincode-coverage.ts) supplies the actual pincode list a
 * RiderPincodeMapping row gets created for; a store with no coverage
 * rows yet falls back to its own single Store.pincode field.
 */
const SEED_FILE = path.join(__dirname, 'data/riders.json');
const RIDER_ROLE_VALUE = 'rider';
const DEFAULT_PASSWORD = 'pressto123';

interface RiderRow {
  id: string;
  phone: string;
  firstName: string;
  lastName: string;
  storeNames: string[];
}

// Normalize: lowercase, strip everything but letters/digits.
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Hand-verified against the real Store table (see class comment above).
// Keyed by normalize(rawStoreNameFromWorkbook) -> real Store.code.
const STORE_NAME_ALIASES: Record<string, string> = {
  bablnath: 'ST113',
  babulnath: 'ST113',
  bandra: 'ST002',
  bandrapsb: 'ST090',
  bandrapdc: 'ST002',
  banjarahills: 'ST095',
  banjariahills: 'ST095',
  crpark: 'ST092',
  carmichael: 'ST005',
  centralplaza: 'ST010', // Rider List collapses this same rider to "Gurgaon"
  chembur: 'ST034',
  colaba: 'ST006',
  colabapsb: 'ST083',
  defencecolony: 'ST007',
  estate: 'ST105', // Hiranandani Estate
  gk1: 'ST008',
  gk2: 'ST009',
  goregaon: 'ST097',
  gurgaon: 'ST010',
  hauzkhas: 'ST093',
  hibiscus: 'ST084',
  indiranagar: 'ST059',
  jacobcircle: 'ST086',
  jayanagar: 'ST088',
  juhukalaniketan: 'ST014',
  kandivali: 'ST039',
  koramangala: 'ST065',
  lalbaug: 'ST016',
  lalbuag: 'ST016',
  lowerparel: 'ST036',
  malad: 'ST012',
  meadows: 'ST037',
  modeltown: 'ST094',
  nfc: 'ST021',
  narainavihar: 'ST116',
  nepeansea: 'ST018',
  nepeanseapsb: 'ST020',
  newfriendscolony: 'ST021',
  noida: 'ST099',
  oshiwara: 'ST022',
  psbjayanagar: 'ST089',
  psbbanjarahills: 'ST096',
  psbbandra: 'ST090',
  psbcolaba: 'ST083',
  psbdefencecolony: 'ST087',
  psbindiranagar: 'ST060',
  psbkoramangala: 'ST066',
  pitampura: 'ST114',
  powai: 'ST023',
  prabhadevi: 'ST024',
  punjabibagh: 'ST030',
  rajourigarden: 'ST112',
  richmond: 'ST108',
  richmondcircle: 'ST108',
  sadashivanagar: 'ST091',
  saket: 'ST049',
  santacruz: 'ST026',
  vasantkunj: 'ST106',
  vasantvihar: 'ST027',
  vashi: 'ST109',
  versova: 'ST028',
  vileparle: 'ST098',
  whitefield: 'ST082',
  // No matching store exists yet for "Panchsheel Enclave" — left
  // unmapped deliberately; resolveStoreCode() logs it as unresolved.
};

async function seedRiders() {
  if (!fs.existsSync(SEED_FILE)) {
    console.error('Seed file not found:', SEED_FILE);
    console.error('Run: node scripts/migrate-riders.cjs');
    process.exit(1);
  }
  const {riders}: {riders: RiderRow[]} = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));

  const app = new presstoBackendApplication();
  await app.boot();
  await app.start();

  const usersRepo = await app.getRepository(Repos.UsersRepository);
  const riderRepo = await app.getRepository(Repos.RiderRepository);
  const rolesRepo = await app.getRepository(Repos.RolesRepository);
  const userRolesRepo = await app.getRepository(Repos.UserRolesRepository);
  const storeRepo = await app.getRepository(Repos.StoreRepository);
  const coverageRepo = await app.getRepository(Repos.StorePincodeCoverageRepository);
  const pincodeMappingRepo = await app.getRepository(Repos.RiderPincodeMappingRepository);
  const hasher = await app.get<BcryptHasher>('service.hasher');

  // ── Store name -> Store row, and Store -> its pincode list ────────────────
  const allStores = await storeRepo.find({fields: {id: true, code: true, name: true, pincode: true, address: true}});
  const storeByCode = new Map(allStores.map(s => [s.code, s]));
  const storeByNormalizedName = new Map(allStores.map(s => [normalize(s.name), s]));

  const unresolvedStoreNames = new Set<string>();
  function resolveStore(rawName: string) {
    const key = normalize(rawName);
    const code = STORE_NAME_ALIASES[key];
    const store = code ? storeByCode.get(code) : storeByNormalizedName.get(key);
    if (!store) unresolvedStoreNames.add(rawName);
    return store;
  }

  const pincodesForStoreId = new Map<string, string[]>();
  async function pincodesForStore(storeId: string, fallbackPincode: string): Promise<string[]> {
    if (pincodesForStoreId.has(storeId)) return pincodesForStoreId.get(storeId)!;
    const coverage = await coverageRepo.find({where: {storeId} as object, fields: {pincode: true}});
    const pincodes = coverage.length ? [...new Set(coverage.map(c => c.pincode))] : [fallbackPincode];
    pincodesForStoreId.set(storeId, pincodes);
    return pincodes;
  }

  // ── The 'rider' role, self-healing exactly like RiderController.resolveRiderRole() ──
  let riderRole = await rolesRepo.findOne({where: {value: RIDER_ROLE_VALUE}});
  if (!riderRole) {
    riderRole = await rolesRepo.create({
      value: RIDER_ROLE_VALUE,
      label: 'Rider',
      description: 'Rider app account — signs in by phone + OTP. No admin access.',
      isLocked: true,
      loginAccess: false,
      scope: 'store',
      isActive: true,
      isDeleted: false,
    });
  }

  async function generateUniqueUsername(fullName: string): Promise<string> {
    const base = fullName.trim().toLowerCase().replace(/\s+/g, '.') || 'rider';
    let username = base;
    for (let attempt = 0; attempt < 10; attempt++) {
      const existing = await usersRepo.findOne({where: {username}});
      if (!existing) return username;
      username = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
    }
    throw new Error(`Could not generate a unique username for ${fullName}`);
  }

  async function generateRiderCode(): Promise<string> {
    const existing = await riderRepo.find({fields: {riderCode: true}});
    let maxNum = 0;
    for (const r of existing) {
      const match = r.riderCode?.match(/^RID(\d+)$/i);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
    return `RID${String(maxNum + 1).padStart(3, '0')}`;
  }

  let createdRiders = 0;
  let matchedExistingRiders = 0;
  let mappingsCreated = 0;
  let mappingsAlreadyPresent = 0;

  for (const row of riders) {
    const fullName = `${row.firstName} ${row.lastName === '-' ? '' : row.lastName}`.trim();

    let user = await usersRepo.findOne({where: {phone: row.phone}});
    let rider = user ? await riderRepo.findOne({where: {userId: user.id}}) : null;

    if (!user) {
      const hashedPassword = await hasher.hashPassword(DEFAULT_PASSWORD);
      user = await usersRepo.create({
        fullName,
        username: await generateUniqueUsername(fullName),
        countryCode: '+91',
        phone: row.phone,
        password: hashedPassword,
        isActive: true,
      });
    }

    if (!rider) {
      rider = await riderRepo.create({
        userId: user.id,
        riderCode: await generateRiderCode(),
        riderType: RiderType.RIDER,
        firstName: row.firstName,
        lastName: row.lastName,
        // No address data exists in the workbook — the resolved store's own
        // address is the closest real fallback (a rider plausibly reports
        // there); "Address not provided" only for the one rider this run
        // can't resolve to any store at all.
        address: 'Address not provided',
      });
      createdRiders += 1;
    } else {
      matchedExistingRiders += 1;
    }

    const alreadyHasRole = await userRolesRepo.findOne({where: {usersId: user.id, rolesId: riderRole.id}});
    if (!alreadyHasRole) {
      await userRolesRepo.create({usersId: user.id, rolesId: riderRole.id});
    }

    // ── Coverage: union of every resolvable store's pincodes ────────────────
    const resolvedStores = row.storeNames.map(resolveStore).filter((s): s is NonNullable<typeof s> => Boolean(s));
    if (resolvedStores.length && rider.address === 'Address not provided') {
      await riderRepo.updateById(rider.id, {address: resolvedStores[0].address});
    }

    const pincodes = new Set<string>();
    for (const store of resolvedStores) {
      for (const pincode of await pincodesForStore(store.id, store.pincode)) pincodes.add(pincode);
    }

    for (const pincode of pincodes) {
      const existingMapping = await pincodeMappingRepo.findOne({where: {riderId: rider.id, pincode} as object});
      if (existingMapping) {
        mappingsAlreadyPresent += 1;
        continue;
      }
      await pincodeMappingRepo.create({riderId: rider.id, pincode});
      mappingsCreated += 1;
    }
  }

  console.log(`Riders created: ${createdRiders}, matched existing: ${matchedExistingRiders}`);
  console.log(`Pincode mappings created: ${mappingsCreated}, already present: ${mappingsAlreadyPresent}`);
  if (unresolvedStoreNames.size) {
    console.log(
      `Unresolved store name(s) (no matching Store row — skipped): ${[...unresolvedStoreNames].sort().join(', ')}`,
    );
  }

  console.log('Rider seed complete.');
  await app.stop();
  process.exit(0);
}

seedRiders().catch(err => {
  console.error('Rider seed failed:', err);
  process.exit(1);
});
