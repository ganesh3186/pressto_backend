/* eslint-disable @typescript-eslint/no-explicit-any */
/** Opt-in PostgreSQL tests. Only session-local temporary tables are written. */
export function pettySqlFixture(service: any) {
  service.pettyCashRegisterRepo.execute = async (sql: string, params: any[]) => {
    const {Client} = require('pg');
    const client = new Client({host: process.env.PG_HOST, port: Number(process.env.PG_PORT),
      user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE});
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE shift (id text, storeid text, openedat timestamptz, closedat timestamptz,
        status text, openingno int, closureno int, storename text, opening jsonb, closing jsonb) ON COMMIT DROP;
        CREATE TEMP TABLE petty_cash_register_entry (id text, storeid text, createdat timestamptz, expensedate timestamptz,
        isdeleted boolean, description text, remarks text, method text, username text, storename text,
        status text, amount numeric, approvedamount numeric, disapprovedamt numeric) ON COMMIT DROP;
        CREATE TEMP TABLE petty_cash_finance_entry (id text, storeid text, createdat timestamptz,
        amount numeric, storename text, remarks text, createdbyname text) ON COMMIT DROP`);
      const insert = async (table: string, rows: any[]) => {
        for (const row of rows) {
          const data: any = {storeid: params[0][0], ...Object.fromEntries(Object.entries(row).map(([k,v]) => [k.toLowerCase(), v]))};
          if (table === 'shift') data.status ??= data.closedat ? 'closed' : 'open';
          if (table === 'petty_cash_register_entry') {
            data.expensedate ??= params[1]; data.createdat ??= data.expensedate; data.isdeleted ??= false;
          }
          const keys = Object.keys(data);
          await client.query(`INSERT INTO pg_temp.${table} (${keys.join(',')}) VALUES (${keys.map((_,i) => '$'+(i+1)).join(',')})`, keys.map(k => data[k]));
        }
      };
      await insert('shift', await service.shiftRepo.find({}));
      await insert('petty_cash_register_entry', await service.pettyCashRegisterRepo.find({}));
      await insert('petty_cash_finance_entry', service.pettyCashFinanceRepo ? await service.pettyCashFinanceRepo.find({}) : []);
      return (await client.query(sql.replace(/public\./g, 'pg_temp.').replace(/uuid\[\]/g, 'text[]'), params)).rows;
    } finally {await client.query('ROLLBACK'); await client.end();}
  };
}
