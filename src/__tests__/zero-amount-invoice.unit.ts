import {expect} from '@loopback/testlab';
import {securityId, UserProfile} from '@loopback/security';
import {InvoiceController} from '../controllers/invoice.controller';
import {OrderService} from '../services/order.service';

describe('zero-amount invoice', () => {
  it('generates an invoice for a ready ticket with nothing to collect', async () => {
    let savedInvoice: Record<string, unknown> | undefined;
    const orderService = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {
        beginTransaction: async () => ({commit: async () => {}, rollback: async () => {}}),
        execute: async () => [],
      },
      computeBalanceDue: async () => ({due: 0, alreadyPaid: 0}),
      allocateInvoiceNumber: async () => 'INV-202610-00001',
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
    }) as OrderService;
    const controller = Object.assign(Object.create(InvoiceController.prototype), {
      orderService,
    }) as InvoiceController;

    const result = await controller.generate({
      [securityId]: '00000000-0000-4000-8000-000000000001',
    } as UserProfile, 'free-order');

    expect(result).to.have.property('message', 'Invoice available.');
    expect(savedInvoice?.orderId).to.equal('free-order');
    expect(savedInvoice?.totalAmount).to.equal(0);
    expect(savedInvoice?.balanceDue).to.equal(0);
  });
});
