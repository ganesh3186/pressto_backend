require('dotenv').config();

const {Client} = require('pg');

async function setBagCapacity() {
  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });

  await client.connect();
  try {
    const result = await client.query(
      'UPDATE public.bag SET maxcapacity = 500 WHERE maxcapacity = 25 OR maxcapacity IS NULL',
    );
    const remaining = await client.query(
      'SELECT COUNT(*)::int AS count FROM public.bag WHERE maxcapacity = 25 OR maxcapacity IS NULL',
    );
    if (remaining.rows[0].count !== 0) throw new Error('Some bags still have the old capacity.');
    console.log(`Updated ${result.rowCount} bags to a 500-item capacity.`);
  } finally {
    await client.end();
  }
}

setBagCapacity().catch(error => {
  console.error('Could not update bag capacity:', error.message);
  process.exit(1);
});
