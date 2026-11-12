require('dotenv').config();

const {Client} = require('pg');

async function migrate() {
  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });
  await client.connect();
  try {
    await client.query('ALTER TABLE public.store ADD COLUMN IF NOT EXISTS gstnumber TEXT');
    await client.query('ALTER TABLE public.store ALTER COLUMN gstnumber DROP NOT NULL');
    console.log('Optional store GST number column is available.');
  } finally {
    await client.end();
  }
}

migrate().catch(error => {
  console.error('Could not add store GST number column:', error.message);
  process.exit(1);
});
