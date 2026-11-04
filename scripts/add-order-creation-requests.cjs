require('dotenv').config();
const {Client} = require('pg');
// Usage: node scripts/add-order-creation-requests.cjs [--prune-days=N]
// Retries only matter for minutes, so rows older than N days can be pruned safely.
const pruneArg = process.argv.find(arg => arg.startsWith('--prune-days='));
const pruneDays = pruneArg ? Number(pruneArg.split('=')[1]) : null;
async function migrate() {
  if (pruneArg && !(Number.isInteger(pruneDays) && pruneDays >= 1)) {
    throw new Error('--prune-days must be a whole number of days, 1 or more.');
  }
  const client = new Client({host: process.env.PG_HOST, port: Number(process.env.PG_PORT),
    user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE});
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.order_creation_request (
      request_key text PRIMARY KEY, fingerprint text NOT NULL,
      response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`CREATE INDEX IF NOT EXISTS order_creation_request_created_at_idx
      ON public.order_creation_request (created_at)`);
    console.log('Order creation retry storage is available.');
    if (pruneDays) {
      const result = await client.query(
        `DELETE FROM public.order_creation_request WHERE created_at < now() - make_interval(days => $1)`, [pruneDays]);
      console.log(`Pruned ${result.rowCount} retry record(s) older than ${pruneDays} day(s).`);
    }
  } finally {await client.end();}
}
migrate().catch(error => {console.error(error.message); process.exitCode = 1;});
