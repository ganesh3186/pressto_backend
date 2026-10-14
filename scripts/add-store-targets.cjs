require('dotenv').config();

const {Client} = require('pg');

async function addStoreTargets() {
  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });

  await client.connect();
  try {
    await client.query(`
      ALTER TABLE public.store
        ADD COLUMN IF NOT EXISTS itemtarget INTEGER,
        ADD COLUMN IF NOT EXISTS servicetarget INTEGER,
        ADD COLUMN IF NOT EXISTS revenuetarget DECIMAL
    `);
    console.log('Store target fields are available.');
  } finally {
    await client.end();
  }
}

addStoreTargets().catch(error => {
  console.error('Could not add store target fields:', error.message);
  process.exit(1);
});
