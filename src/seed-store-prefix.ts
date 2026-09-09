import {presstoBackendApplication} from './application';
import {StoreRepository} from './repositories';

/**
 * Backfill an order prefix for every store that does not already have one.
 *
 * Store codes are already unique, so they provide deterministic, collision-free
 * prefixes. Existing prefixes are preserved, making this seed safe to rerun.
 */
async function seedStorePrefixes() {
  const app = new presstoBackendApplication();

  try {
    await app.boot();
    const storeRepository = await app.getRepository(StoreRepository);
    const stores = await storeRepository.find({order: ['code ASC']});

    let updated = 0;
    let skipped = 0;

    for (const store of stores) {
      if (store.storePrefix?.trim()) {
        skipped += 1;
        continue;
      }

      const prefix = store.code?.trim().toUpperCase();
      if (!prefix) {
        console.warn(`Skipped store ${store.id}: it has no store code.`);
        skipped += 1;
        continue;
      }

      await storeRepository.updateById(store.id, {storePrefix: prefix});
      console.log(`${store.name} (${store.code}) -> ${prefix}`);
      updated += 1;
    }

    console.log(
      `Store-prefix seed complete: ${updated} updated, ${skipped} unchanged.`,
    );
  } finally {
    await app.stop();
  }
}

seedStorePrefixes().catch(err => {
  console.error('Store-prefix seed failed:', err);
  process.exit(1);
});
