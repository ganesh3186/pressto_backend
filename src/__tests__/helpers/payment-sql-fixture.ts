/* eslint-disable @typescript-eslint/no-explicit-any */
/** Exercise the production UNION query using temporary tables, never real rows. */
export function paymentSqlFixture(service: any) {
  service.paymentTransactionRepo.execute = async (sql: string, params: any[]) => {
    const {Client} = require('pg');
    const c = new Client({host: process.env.PG_HOST,port: Number(process.env.PG_PORT),user:process.env.PG_USER,
      password:process.env.PG_PASSWORD,database:process.env.PG_DATABASE});
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`CREATE TEMP TABLE orders(id text,storeid text) ON COMMIT DROP;
        CREATE TEMP TABLE shift(id text,storeid text) ON COMMIT DROP;
        CREATE TEMP TABLE payment_transaction(id text,orderid text,paymentdate timestamptz,
          cashshiftid text,paymentmode text,transactiontype text,amount numeric) ON COMMIT DROP;
        CREATE TEMP TABLE customer(id text,preferredstoreid text) ON COMMIT DROP;
        CREATE TEMP TABLE wallet_recharge_request(id text,customerid text,createdat timestamptz,status text,paymentmode text,amount numeric) ON COMMIT DROP;
        CREATE TEMP TABLE invoice(id text,createdat timestamptz,status text,isconsolidated boolean) ON COMMIT DROP;
        CREATE TEMP TABLE invoice_order_link(invoiceid text,orderid text,ordertotal numeric) ON COMMIT DROP`);
      const rows = async (repo: any, filter: any) => repo?.find ? repo.find(filter) : [];
      const insert = async (table: string, records: any[], fields: string[], defaults: any = {}) => {
        for (const record of records) {
          const row = {...defaults,...record};
          if (fields.includes('id') && !row.id) continue;
          await c.query(`INSERT INTO pg_temp.${table} (${fields.map(f=>f.toLowerCase()).join(',')}) VALUES (${fields.map((_,i)=>'$'+(i+1)).join(',')})`, fields.map(f=>row[f] ?? null));
        }
      };
      await insert('orders', await rows(service.orderRepo,{where:{}}),['id','storeId']);
      await insert('shift', await rows(service.shiftRepo,{where:{storeId:{inq:params[0]}}}),['id','storeId']);
      await insert('payment_transaction', await rows(service.paymentTransactionRepo,{where:{}}),
        ['id','orderId','paymentDate','cashShiftId','paymentMode','transactionType','amount']);
      await insert('invoice', await rows(service.invoiceRepo,{where:{status:'issued'}}),['id','createdAt','status','isConsolidated'],
        {status:'issued',isConsolidated:Boolean(service.invoiceOrderLinkRepo)});
      await insert('invoice_order_link',await rows(service.invoiceOrderLinkRepo,{where:{}}),['invoiceId','orderId','orderTotal']);
      return (await c.query(sql.replace(/public\./g,'pg_temp.').replace(/uuid/g,'text'),params)).rows;
    } finally {await c.query('ROLLBACK');await c.end();}
  };
}
