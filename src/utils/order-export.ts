export interface OrderExportFilters {
  customerName?: string;
  orderId?: string;
  placedBy?: string;
  source?: string;
  orderType?: string;
  status?: string;
  paymentStatus?: string;
  dateFrom?: string;
  dateTo?: string;
  storeId?: string;
  clusterId?: string;
}

interface ExportOrder {
  orderNumber?: string;
  orderType?: string;
  status?: string;
  placedByName?: string | null;
  placedByRelationship?: string | null;
  paymentStatus?: string;
  customer?: {
    fullName?: string;
    firstName?: string;
    lastName?: string;
    phone?: string | null;
  } | null;
}

const familyRelationships = new Set([
  'wife',
  'husband',
  'son',
  'daughter',
  'father',
  'mother',
  'brother',
  'sister',
]);
const householdRelationships = new Set([
  'househelp',
  'household_help',
  'driver',
]);

function matchesText(value: unknown, query: string): boolean {
  return String(value ?? '')
    .toLowerCase()
    .includes(query.toLowerCase());
}

function displayOrderType(value: string): string {
  if (value.includes('whatsapp')) return 'whatsapp';
  if (['web', 'app', 'online'].some(part => value.includes(part)))
    return 'web_app';
  if (['call', 'phone', 'operator'].some(part => value.includes(part)))
    return 'call';
  if (['store', 'counter', 'walk'].some(part => value.includes(part)))
    return 'in_store';
  return value || 'in_store';
}

/** Additional Manage Ticket filters applied to server-enriched, scoped rows. */
export function matchesOrderExportFilters(
  row: ExportOrder,
  filters: OrderExportFilters,
): boolean {
  const customer = row.customer;
  const name =
    String(
      customer?.fullName ??
        `${customer?.firstName ?? ''} ${customer?.lastName ?? ''}`,
    )
      .split(/\s+/)
      .filter(
        part => part && !['null', 'undefined'].includes(part.toLowerCase()),
      )
      .join(' ') || 'Customer';
  if (
    filters.customerName &&
    !matchesText(name, filters.customerName) &&
    !matchesText(customer?.phone, filters.customerName)
  )
    return false;
  if (filters.orderId && !matchesText(row.orderNumber, filters.orderId))
    return false;

  if (filters.placedBy && filters.placedBy !== 'all') {
    const relationship = String(row.placedByRelationship ?? '').toLowerCase();
    const category =
      !row.placedByName && !relationship
        ? 'self'
        : householdRelationships.has(relationship)
          ? 'household'
          : familyRelationships.has(relationship)
            ? 'family'
            : 'other';
    if (category !== filters.placedBy) return false;
  }

  const rawType = String(row.orderType ?? '')
    .trim()
    .toLowerCase();
  const source =
    !rawType ||
    ['store', 'dropoff', 'counter', 'walk'].some(part => rawType.includes(part))
      ? 'in_store'
      : 'online';
  if (filters.source && filters.source !== 'all' && source !== filters.source)
    return false;
  if (
    filters.orderType &&
    filters.orderType !== 'all' &&
    displayOrderType(rawType) !== filters.orderType
  )
    return false;

  if (filters.paymentStatus && filters.paymentStatus !== 'all') {
    const cancelled = row.status === 'cancelled';
    const hasBilling = row.status !== 'draft' && !cancelled;
    const paymentStatus =
      row.paymentStatus === 'paid' ? 'success' : row.paymentStatus ?? 'pending';
    if (filters.paymentStatus === 'cancelled' && cancelled) return true;
    if (!hasBilling) return filters.paymentStatus === 'unpaid';
    if (paymentStatus !== filters.paymentStatus) return false;
  }
  return true;
}

/** Fetch every page; the table's page/size never limits an export. */
export async function collectOrderExportRows(
  loadBatch: (skip: number, limit: number) => Promise<{rows: object[]}>,
  filters: OrderExportFilters,
): Promise<{rows: object[]; total: number}> {
  const rows: object[] = [];
  const batchSize = 100;
  for (let skip = 0; ; skip += batchSize) {
    const batch = await loadBatch(skip, batchSize);
    rows.push(
      ...batch.rows.filter(row => matchesOrderExportFilters(row, filters)),
    );
    if (batch.rows.length < batchSize) break;
  }
  return {rows, total: rows.length};
}
