import {InvoiceStatus} from '../models/invoice.model';

/**
 * Once an invoice is issued its amounts never change: subtotal, discount, tax,
 * total and items stay as they were billed. Only payment columns move
 * (amountReceived, balanceDue). Anything that changes what the customer owes
 * afterwards changes the order, and the invoice's balance follows from that.
 *
 * Only an explicit draft is unlocked, so a row with no status is treated as issued.
 */
export function invoiceAmountsLocked(invoice: {status?: string}): boolean {
  return invoice.status !== InvoiceStatus.DRAFT;
}
