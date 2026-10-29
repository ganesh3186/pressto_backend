import {expect} from '@loopback/testlab';
import {securityId, UserProfile} from '@loopback/security';
import {InvoiceController} from '../controllers/invoice.controller';

describe('zero-amount invoice', () => {
  it('records incoming payments without adding paid refunds', async () => {
    let savedInvoice: Record<string, unknown> | undefined;
    const controller = Object.assign(Object.create(InvoiceController.prototype), {
      orderRepo: {findOne: async () => ({id: 'damage-order', status: 'ready', totalAmount: 0})},
      invoiceRepo: {findOne: async () => null, count: async () => ({count: 0}),
        create: async (invoice: Record<string, unknown>) => {savedInvoice = invoice; return invoice;}},
      orderItemRepo: {find: async () => []},
      paymentRepo: {find: async () => [
        {transactionType: 'payment', amount: 775},
        {transactionType: 'refund', amount: 448},
      ]},
      challanRepo: {findOne: async () => null},
    }) as InvoiceController;

    await controller.generate({[securityId]: 'staff-1'} as UserProfile, 'damage-order');
    expect(savedInvoice?.amountReceived).to.equal(775);
    expect(savedInvoice?.balanceDue).to.equal(0);
  });

  it('generates an invoice for a ready ticket with nothing to collect', async () => {
    let savedInvoice: Record<string, unknown> | undefined;
    const controller = Object.assign(Object.create(InvoiceController.prototype), {
      orderRepo: {findOne: async () => ({id: 'free-order', status: 'ready', totalAmount: 0})},
      invoiceRepo: {
        findOne: async () => null,
        count: async () => ({count: 0}),
        create: async (invoice: Record<string, unknown>) => {
          savedInvoice = invoice;
          return invoice;
        },
      },
      orderItemRepo: {find: async () => []},
      paymentRepo: {find: async () => []},
      challanRepo: {findOne: async () => null},
    }) as InvoiceController;

    const result = await controller.generate({[securityId]: 'staff-1'} as UserProfile, 'free-order');

    expect(result).to.have.property('message', 'Invoice generated.');
    expect(savedInvoice?.orderId).to.equal('free-order');
    expect(savedInvoice?.totalAmount).to.equal(0);
    expect(savedInvoice?.balanceDue).to.equal(0);
  });
});
