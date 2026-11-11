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
    await client.query(
      'ALTER TABLE public.pickup_request ' +
        'ADD COLUMN IF NOT EXISTS pickuplatitude DECIMAL, ' +
        'ADD COLUMN IF NOT EXISTS pickuplongitude DECIMAL',
    );
    console.log('Pickup request coordinate columns are available.');
  } finally {
    await client.end();
  }
}

migrate().catch(error => {
  console.error('Could not add pickup request coordinate columns:', error.message);
  process.exit(1);
});
