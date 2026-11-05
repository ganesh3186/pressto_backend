import {expect} from '@loopback/testlab';
import {InvoiceController} from '../controllers/invoice.controller';
import {OrderService} from '../services/order.service';
import {invoiceAmountsLocked} from '../utils/invoice-lock';

// Billed 1000, 750 received, 250 settled by a credit note: the order drops to 750.
const billed = () => ({
  id: 'invoice-1',
  orderId: 'order-1',
  status: 'issued',
  subtotal: 847.46,
  discount: 0,
  cgst: 76.27,
  sgst: 76.27,
  totalAmount: 1000,
  amountReceived: 750,
  balanceDue: 0,
});
const afterCredit = {
  id: 'order-1',
  status: 'delivered',
  subtotal: 635.6,
  discountAmount: 0,
  taxAmount: 114.4,
  totalAmount: 750,
};

function serviceWith(invoice: ReturnType<typeof billed>, writes: object[]) {
  return Object.assign(Object.create(OrderService.prototype), {
    dataSource: {
      beginTransaction: async () => ({commit: async () => {}, rollback: async () => {}}),
      execute: async () => {},
    },
    orderRepo: {findOne: async () => afterCredit, findById: async () => afterCredit},
    computeBalanceDue: async () => ({alreadyPaid: 750, due: 0}),
    invoiceRepo: {
      findOne: async () => invoice,
      findById: async () => invoice,
      updateById: async (_id: string, patch: object) => {
        writes.push(patch);
        Object.assign(invoice, patch);
      },
    },
  }) as OrderService;
}

describe('issued invoice amounts are locked', () => {
  it('unlocks only an explicit draft', () => {
    expect(invoiceAmountsLocked({status: 'issued'})).to.be.true();
    expect(invoiceAmountsLocked({})).to.be.true();
    expect(invoiceAmountsLocked({status: 'draft'})).to.be.false();
  });

  it('writes nothing when an issued invoice is read after a credit note', async () => {
    const invoice = billed();
    const writes: object[] = [];
    const service = serviceWith(invoice, writes);

    const read = await service.syncInvoiceTotalsForOrder(afterCredit as never);

    expect(writes).to.deepEqual([]);
    expect(read).to.containEql({totalAmount: 1000, subtotal: 847.46, cgst: 76.27});
  });

  it('shows 1000 billed and 750 payable when the invoice is opened', async () => {
    const invoice = billed();
    const controller = Object.assign(Object.create(InvoiceController.prototype), {
      storeScopeService: {assertOrderVisible: async () => {}},
      orderRepo: {findOne: async () => afterCredit},
      orderService: serviceWith(invoice, []),
      salesReturnRepo: {
        find: async () => [{
          invoiceId: 'invoice-1',
          creditAmount: 250,
          returnedItems: [{preservesInvoice: true}],
        }],
      },
    }) as InvoiceController;

    const result = (await controller.getByOrder('order-1', {} as never)) as {invoice: object};

    expect(result.invoice).to.containEql({
      totalAmount: 1000,
      creditNotesTotal: 250,
      netPayable: 750,
    });
  });

  it('moves only the payment columns when an invoice is generated again', async () => {
    const invoice = billed();
    const writes: object[] = [];
    const service = serviceWith(invoice, writes);

    await service.generateInvoiceForOrder('order-1', 'staff-1');

    expect(writes).to.deepEqual([{amountReceived: 750, balanceDue: 0}]);
    expect(invoice.totalAmount).to.equal(1000);
  });
});
