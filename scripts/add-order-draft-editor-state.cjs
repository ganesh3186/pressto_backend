require('dotenv').config();

const {Client} = require('pg');

async function addOrderDraftEditorState() {
  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });
  await client.connect();
  try {
    await client.query('ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS drafteditorstate JSONB');
    await client.query('ALTER TABLE public.order_item ADD COLUMN IF NOT EXISTS draftunitinspections JSONB');
    console.log('Draft editor state is available.');
  } finally {
    await client.end();
  }
}

module.exports = {addOrderDraftEditorState};

if (require.main === module)
  addOrderDraftEditorState().catch(error => {
    console.error('Could not add draft editor state:', error.message);
    process.exit(1);
  });
