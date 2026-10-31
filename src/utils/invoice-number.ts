/** Invoice dates and financial years follow the business timezone, not the server timezone. */
export function invoiceNumberPeriod(at: Date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(at);
  const year = Number(parts.find(part => part.type === 'year')!.value);
  const month = Number(parts.find(part => part.type === 'month')!.value);
  return {
    monthYear: `${String(month).padStart(2, '0')}${String(year).slice(-2)}`,
    financialYear: month >= 4 ? year : year - 1,
  };
}

export function formatInvoiceNumber(
  prefix: string,
  monthYear: string,
  sequence: string,
): string {
  const normalizedSequence = sequence.replace(/^0+/, '');
  if (!prefix.trim() || !/^\d+$/.test(sequence) || !normalizedSequence) {
    throw new Error(
      'A store prefix and positive invoice sequence are required.',
    );
  }
  return `${prefix.trim()}-${monthYear}-${normalizedSequence.padStart(6, '0')}`;
}
