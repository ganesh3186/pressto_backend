/** One globally ordered page across tender transactions, top-ups and invoice events. */
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
  FROM public.wallet_recharge_request r JOIN public.customer c ON c.id = r.customerid
  WHERE r.status = 'success' AND r.createdat BETWEEN $2 AND $3 AND c.preferredstoreid = ANY($1::uuid[])
  UNION ALL
  SELECT 'on-account-invoice:' || i.id || ':' || o.storeid, i.id, 'invoice', i.createdat,
    null::uuid,'on_account',floor(sum(COALESCE(l.ordertotal,0))*100+.5)/100,0
  FROM public.invoice i JOIN public.invoice_order_link l ON l.invoiceid = i.id JOIN public.orders o ON o.id = l.orderid
  WHERE i.status = 'issued' AND i.isconsolidated = true AND i.createdat BETWEEN $2 AND $3
    AND o.storeid = ANY($1::uuid[])
  GROUP BY i.id,i.createdat,o.storeid HAVING sum(COALESCE(l.ordertotal,0)) > 0
), modes AS (
  SELECT mode, floor(sum(amount)*100+.5)/100 AS amount FROM ledger WHERE refund = 0 GROUP BY mode
)
SELECT count(*)::int AS count, COALESCE(sum(amount),0) AS amount, COALESCE(sum(refund),0) AS refund,
  COALESCE((SELECT jsonb_object_agg(COALESCE(mode,'—'),amount) FROM modes),'{}'::jsonb) AS modes,
  COALESCE((SELECT jsonb_agg(page) FROM (SELECT id,sourceid,kind,cashshiftid FROM ledger
    ORDER BY at DESC,id DESC LIMIT $4 OFFSET $5) page),'[]'::jsonb) AS page FROM ledger`;
