require('dotenv').config();

const {Client} = require('pg');

async function addCustomerPersonaColumn() {
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
      'ALTER TABLE public.customer ADD COLUMN IF NOT EXISTS persona VARCHAR',
    );
    console.log('customer.persona column is available.');
  } finally {
    await client.end();
  }
}

addCustomerPersonaColumn().catch(error => {
  console.error('Could not add customer.persona:', error.message);
  process.exit(1);
});
