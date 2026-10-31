/** Ticket sequences use calendar months in India, independently of invoice years. */
export function ticketNumberPeriod(at: Date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(at);
  const year = parts.find(part => part.type === 'year')!.value;
  const month = parts.find(part => part.type === 'month')!.value;
  return {period: Number(`${year}${month}`), monthYear: `${month}${year.slice(-2)}`};
}
