/** Ledger balances use creation time; visible expense rows use expense date. */
export const PETTY_CASH_REPORT_SQL = `WITH shifts AS MATERIALIZED (
  SELECT * FROM public.shift WHERE storeid = ANY($1::uuid[]) AND openedat <= $3
    AND (closedat >= $2 OR status = 'open')
), expenses AS MATERIALIZED (
  SELECT e.*, (SELECT s.id FROM shifts s WHERE s.storeid = e.storeid AND e.createdat >= s.openedat
    AND (s.closedat IS NULL OR e.createdat <= s.closedat) ORDER BY s.openedat,s.id LIMIT 1) AS shift_id
  FROM public.petty_cash_register_entry e WHERE e.storeid = ANY($1::uuid[])
    AND e.isdeleted = false AND e.expensedate BETWEEN $2 AND $3
), finance AS MATERIALIZED (
  SELECT f.*, (SELECT s.id FROM shifts s WHERE s.storeid = f.storeid AND f.createdat >= s.openedat
    AND (s.closedat IS NULL OR f.createdat <= s.closedat) ORDER BY s.openedat,s.id LIMIT 1) AS shift_id
  FROM public.petty_cash_finance_entry f WHERE f.storeid = ANY($1::uuid[]) AND f.createdat BETWEEN $2 AND $3
), relevant AS MATERIALIZED (
  SELECT s.* FROM shifts s WHERE s.openedat BETWEEN $2 AND $3 OR s.closedat BETWEEN $2 AND $3
    OR s.id IN (SELECT shift_id FROM expenses) OR s.id IN (SELECT shift_id FROM finance)
), ledger_events AS (
  SELECT '0-finance:' || f.id AS id, f.createdat AS at, s.id AS shift_id,
    CASE WHEN f.createdat = s.openedat THEN 0 ELSE COALESCE(f.amount,0) END AS delta
  FROM public.petty_cash_finance_entry f JOIN relevant s ON s.id = (
    SELECT x.id FROM shifts x WHERE x.storeid = f.storeid AND f.createdat >= x.openedat
      AND f.createdat <= COALESCE(x.closedat,$3) ORDER BY x.openedat,x.id LIMIT 1)
  UNION ALL
  SELECT '1-expense:' || e.id, e.createdat, s.id,
    CASE WHEN e.status = 'Rejected' THEN 0 WHEN e.status = 'Approved' THEN -COALESCE(e.approvedamount,0)
      ELSE -COALESCE(e.amount,0) END
  FROM public.petty_cash_register_entry e JOIN relevant s ON s.id = (
    SELECT x.id FROM shifts x WHERE x.storeid = e.storeid AND e.createdat >= x.openedat
      AND e.createdat <= COALESCE(x.closedat,$3) ORDER BY x.openedat,x.id LIMIT 1)
  WHERE e.isdeleted = false
), balances AS (
  SELECT e.id, floor((COALESCE((s.opening->'pettyCash'->>'actual')::numeric,0) +
    sum(e.delta) OVER (PARTITION BY e.shift_id ORDER BY e.at,e.id ROWS UNBOUNDED PRECEDING))*100+.5)/100 AS balance
  FROM ledger_events e JOIN relevant s ON s.id = e.shift_id
), events AS MATERIALIZED (
  SELECT e.id::text AS id, e.expensedate AS at, 2 AS rank, jsonb_build_object(
    'id',e.id,'entryType','expense','shiftId',s.id,'expenseDate',e.expensedate,
    'description',COALESCE(e.description,'—'),'remarks',COALESCE(e.remarks,'—'),
    'method',COALESCE(e.method,'—'),'recordedBy',COALESCE(e.username,'—'),'storeName',COALESCE(e.storename,'—'),
    'amount',COALESCE(e.amount,0),'approvedAmount',e.approvedamount,'status',COALESCE(e.status,'pending'),
    'shiftDisapprovedAmt',COALESCE(e.disapprovedamt,0),
    'receivedAmount',COALESCE((s.closing->'pettyCash'->>'recvFromFinance')::numeric,0),
    'shiftTotalExpense',COALESCE((s.closing->'pettyCash'->>'used')::numeric,0),
    'balance',b.balance,'closureNo',COALESCE(s.closureno::text,s.openingno::text,'—')) AS row
  FROM expenses e LEFT JOIN shifts s ON s.id = e.shift_id LEFT JOIN balances b ON b.id = '1-expense:' || e.id
  UNION ALL
  SELECT 'finance-' || f.id, f.createdat, 1, jsonb_build_object(
    'id','finance-' || f.id,'entryType','finance','shiftId',s.id,'expenseDate',f.createdat,
    'storeName',COALESCE(f.storename,s.storename,'—'),'closureNo',COALESCE(s.closureno,s.openingno)::text,
    'description',CASE WHEN f.createdat = s.openedat THEN 'Opening Finance Adjustment' ELSE 'Received from Finance' END,
    'remarks',COALESCE(f.remarks,'—'),'recordedBy',COALESCE(f.createdbyname,'—'),
    'financeAmount',COALESCE(f.amount,0),'balance',b.balance)
  FROM finance f JOIN shifts s ON s.id = f.shift_id LEFT JOIN balances b ON b.id = '0-finance:' || f.id
  UNION ALL
  SELECT 'opening-' || s.id, s.openedat, 0, jsonb_build_object(
    'id','opening-' || s.id,'entryType','opening','shiftId',s.id,'expenseDate',s.openedat,
    'storeName',COALESCE(s.storename,'—'),'closureNo',COALESCE(s.closureno,s.openingno)::text,
    'description','Shift Opening','openingAmount',COALESCE((s.opening->'pettyCash'->>'actual')::numeric,0),
    'shiftOpenDiff',COALESCE((s.opening->'pettyCash'->>'actual')::numeric,0)-COALESCE((s.opening->'pettyCash'->>'supposed')::numeric,0),
    'balance',COALESCE((s.opening->'pettyCash'->>'actual')::numeric,0))
  FROM relevant s WHERE s.openedat BETWEEN $2 AND $3
  UNION ALL
  SELECT 'closing-' || s.id, s.closedat, 3, jsonb_build_object(
    'id','closing-' || s.id,'entryType','closing','shiftId',s.id,'expenseDate',s.closedat,
    'storeName',COALESCE(s.storename,'—'),'closureNo',COALESCE(s.closureno,s.openingno)::text,
    'description','Shift Closing','closingAmount',COALESCE((s.closing->'pettyCash'->>'actualBalance')::numeric,0),
    'shiftClosureDiff',COALESCE((s.closing->'pettyCash'->>'difference')::numeric,0),
    'balance',COALESCE((s.closing->'pettyCash'->>'actualBalance')::numeric,0))
  FROM relevant s WHERE s.closedat BETWEEN $2 AND $3
), descriptions AS (
  SELECT COALESCE(description,'—') AS description,
    floor(sum(CASE WHEN status = 'Approved' THEN COALESCE(approvedamount,0) ELSE COALESCE(amount,0) END)*100+.5)/100 AS amount
  FROM expenses WHERE status IS DISTINCT FROM 'Rejected' GROUP BY COALESCE(description,'—')
)
SELECT (SELECT count(*)::int FROM events) AS count,
  COALESCE((SELECT jsonb_agg(page.row ORDER BY page.at,page.rank,page.id) FROM
    (SELECT * FROM events ORDER BY at,rank,id LIMIT $4 OFFSET $5) page),'[]'::jsonb) AS rows,
  (SELECT jsonb_build_object('claimed',COALESCE(sum(amount),0),'approved',COALESCE(sum(approvedamount),0)) FROM expenses) AS totals,
  COALESCE((SELECT jsonb_object_agg(description,amount) FROM descriptions),'{}'::jsonb) AS descriptions`;
