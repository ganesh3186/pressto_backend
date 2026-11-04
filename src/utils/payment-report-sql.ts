/**
 * One globally ordered page across tender transactions and wallet top-ups.
 * On Account invoice generation moves no money, so it is not a row; its
 * eventual payment appears once, under the mode actually collected. A top-up
 * reports under the store on its request, else the customer's preferred store.
 */
export const PAYMENT_REPORT_SQL = `WITH ledger AS MATERIALIZED (
  SELECT p.id::text AS id, p.id AS sourceid, 'payment' AS kind, p.paymentdate AS at,
    p.cashshiftid, p.paymentmode AS mode,
    CASE WHEN p.transactiontype = 'refund' THEN 0 ELSE COALESCE(p.amount,0) END AS amount,
    CASE WHEN p.transactiontype = 'refund' THEN COALESCE(p.amount,0) ELSE 0 END AS refund
  FROM public.payment_transaction p LEFT JOIN public.orders o ON o.id = p.orderid
  LEFT JOIN public.shift s ON s.id = p.cashshiftid
  WHERE p.paymentdate BETWEEN $2 AND $3
    AND (o.storeid = ANY($1::uuid[]) OR (p.transactiontype = 'refund' AND p.paymentmode = 'cash' AND s.storeid = ANY($1::uuid[])))
    AND (p.transactiontype IS DISTINCT FROM 'refund' OR p.paymentmode IS DISTINCT FROM 'cash'
      OR p.cashshiftid IS NULL OR s.storeid = ANY($1::uuid[]))
  UNION ALL
  SELECT 'wallet-topup:' || r.id, r.id, 'wallet', r.createdat, null::uuid, r.paymentmode, COALESCE(r.amount,0),0
  FROM public.wallet_recharge_request r LEFT JOIN public.customer c ON c.id = r.customerid
  WHERE r.status = 'success' AND r.createdat BETWEEN $2 AND $3
    AND COALESCE(r.storeid, c.preferredstoreid) = ANY($1::uuid[])
), modes AS (
  SELECT mode, floor(sum(amount)*100+.5)/100 AS amount FROM ledger WHERE refund = 0 GROUP BY mode
)
SELECT count(*)::int AS count, COALESCE(sum(amount),0) AS amount, COALESCE(sum(refund),0) AS refund,
  COALESCE((SELECT jsonb_object_agg(COALESCE(mode,'—'),amount) FROM modes),'{}'::jsonb) AS modes,
  COALESCE((SELECT jsonb_agg(page) FROM (SELECT id,sourceid,kind,cashshiftid FROM ledger
    ORDER BY at DESC,id DESC LIMIT $4 OFFSET $5) page),'[]'::jsonb) AS page FROM ledger`;
