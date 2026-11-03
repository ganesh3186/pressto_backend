export function resolveOrderPaymentStatus(
  total: number,
  collected: number,
  orderStatus?: string,
): 'paid' | 'partial' | 'pending' | 'unpaid' {
  const paid = Number(collected) || 0;
  if (orderStatus === 'cancelled') return paid > 0 ? 'paid' : 'unpaid';
  if (orderStatus === 'draft' && paid <= 0) return 'pending';

  const balance = Math.round(((Number(total) || 0) - paid) * 100) / 100;
  if (balance <= 0) return 'paid';
  return paid > 0 ? 'partial' : 'pending';
}

/** Manage Ticket filter values; `paid` is accepted as an alias for Success. */
export const ORDER_PAYMENT_FILTERS = [
  'success',
  'paid',
  'partial',
  'pending',
  'cancelled',
  'unpaid',
] as const;

/**
 * Database counterpart of the table's payment summary. Use the same split
 * allocations and whole-rupee outstanding balance as the order list. Cancelled
 * tickets also appear under Cancelled regardless of money already collected.
 * Alias `o` is the orders row; no client input is interpolated into SQL.
 */
export function orderPaymentFilterSql(
  status: string,
  grouped = false,
): {
  join: string;
  condition: string;
} {
  if (status === 'cancelled')
    return {join: '', condition: "o.status = 'cancelled'"};
  const join = grouped
    ? `LEFT JOIN payment_sums ON payment_sums.orderid = o.id
    CROSS JOIN LATERAL (SELECT CASE
      WHEN o.parentorderid IS NOT NULL THEN COALESCE(o.allocatedpayment, 0) + COALESCE(payment_sums.collected, 0)
      WHEN o.hasbeensplit IS TRUE THEN COALESCE(o.allocatedpayment, 0)
      ELSE COALESCE(payment_sums.collected, 0)
    END AS collected) payment_totals`
    : `LEFT JOIN LATERAL (
    SELECT CASE
      WHEN o.parentorderid IS NOT NULL THEN COALESCE(o.allocatedpayment, 0) + COALESCE(SUM(pt.amount), 0)
      WHEN o.hasbeensplit IS TRUE THEN COALESCE(o.allocatedpayment, 0)
      ELSE COALESCE(SUM(pt.amount), 0)
    END AS collected
    FROM public.payment_transaction pt
    WHERE pt.orderid = o.id AND pt.transactiontype IS DISTINCT FROM 'refund'
  ) payment_totals ON TRUE`;
  const active = "o.status NOT IN ('draft', 'cancelled')";
  // FLOOR(x + .5) matches JavaScript Math.round, including negative ties.
  const due =
    '(FLOOR(COALESCE(o.totalamount, 0) + 0.5) - FLOOR(payment_totals.collected + 0.5))';
  switch (status) {
    case 'success':
    case 'paid':
      return {
        join,
        condition: `((o.status = 'cancelled' AND payment_totals.collected > 0) OR (${active} AND ${due} <= 0))`,
      };
    case 'partial':
      return {
        join,
        condition: `(${active} AND ${due} > 0 AND payment_totals.collected > 0)`,
      };
    case 'pending':
      return {
        join,
        condition: `(${active} AND ${due} > 0 AND payment_totals.collected <= 0)`,
      };
    case 'unpaid':
      return {
        join,
        condition:
          "(o.status = 'draft' OR (o.status = 'cancelled' AND payment_totals.collected <= 0))",
      };
    default:
      throw new Error('Unsupported order payment filter');
  }
}
