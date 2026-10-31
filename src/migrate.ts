import { presstoBackendApplication } from './application';
import { PresstoDataSource } from './datasources';

export async function migrate(args: string[]) {
  const existingSchema = args.includes('--rebuild') ? 'drop' : 'alter';
  console.log('Migrating schemas (%s existing schema)', existingSchema);

  const app = new presstoBackendApplication();
  await app.boot();

  // The trigram (gin_trgm_ops) search indexes declared on the models need
  // this extension, and autoupdate can't create extensions itself.
  const dataSource = await app.get<PresstoDataSource>('datasources.pressto');
  await dataSource.execute('CREATE EXTENSION IF NOT EXISTS pg_trgm');

  await app.migrateSchema({ existingSchema });

  // Connectors usually keep a pool of opened connections,
  // this keeps the process running even after all work is done.
  // We need to exit explicitly.
  process.exit(0);
}

migrate(process.argv).catch(err => {
  console.error('Cannot migrate database schema', err);
  process.exit(1);
});