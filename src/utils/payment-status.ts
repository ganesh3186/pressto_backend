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
