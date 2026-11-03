/* eslint-disable @typescript-eslint/no-explicit-any -- Partial service/repository doubles. */
import {expect} from '@loopback/testlab';
import {securityId, UserProfile} from '@loopback/security';
import {
  formatInvoiceNumber,
  invoiceNumberPeriod,
} from '../utils/invoice-number';
import {OrderService} from '../services/order.service';
import {CustomerBillingController} from '../controllers/customer-billing.controller';

describe('store financial-year invoice numbers', () => {
  it('continues the six-digit legacy series with the store prefix', () => {
    expect(formatInvoiceNumber('DLG11', '1026', '69943')).to.equal(
      'DLG11-1026-069943',
    );
    expect(formatInvoiceNumber('DLG11', '0427', '1')).to.equal(
      'DLG11-0427-000001',
    );
    expect(formatInvoiceNumber('DLG11', '0427', '1000000')).to.equal(
      'DLG11-0427-1000000',
    );
  });

  it('changes calendar month/year without changing financial year in January', () => {
    expect(invoiceNumberPeriod(new Date('2026-10-31T12:00:00Z'))).to.eql({
      monthYear: '1026',
      financialYear: 2026,
    });
    expect(invoiceNumberPeriod(new Date('2026-12-31T18:30:00Z'))).to.eql({
      monthYear: '0127',
      financialYear: 2026,
    });
    expect(invoiceNumberPeriod(new Date('2027-02-01T12:00:00Z'))).to.eql({
      monthYear: '0227',
      financialYear: 2026,
    });
  });

  it('starts the financial year at midnight on April 1 in India', () => {
    expect(invoiceNumberPeriod(new Date('2027-03-31T18:29:59Z'))).to.eql({
      monthYear: '0327',
      financialYear: 2026,
    });
    expect(invoiceNumberPeriod(new Date('2027-03-31T18:30:00Z'))).to.eql({
      monthYear: '0427',
      financialYear: 2027,
    });
  });

  it('rejects an empty prefix or zero/invalid sequence', () => {
    for (const sequence of ['0', '000000', '-1', '1.5', 'NaN']) {
      expect(() => formatInvoiceNumber('DLG11', '1026', sequence)).to.throw();
    }
    expect(() => formatInvoiceNumber('', '1026', '1')).to.throw();
  });

  it('allocates a counter for the store and financial year in the invoice transaction', async () => {
    const tx = {};
    const service = Object.assign(Object.create(OrderService.prototype), {
      storeRepo: {
        findOne: async (filter: any, options: any) => {
          expect(filter.where.id).to.equal('store-1');
          expect(options.transaction).to.equal(tx);
          return {id: 'store-1', storePrefix: 'DLG11'};
        },
      },
      dataSource: {
        execute: async (sql: string, values: unknown[], options: any) => {
          expect(sql).to.match(/ON CONFLICT/);
          expect(values).to.eql(['store-1', 2026]);
          expect(options.transaction).to.equal(tx);
          return [{sequence: '69943'}];
        },
      },
    }) as OrderService;
    expect(
      await service.allocateInvoiceNumber(
        tx as any,
        'store-1',
        new Date('2026-10-31T12:00:00Z'),
      ),
    ).to.equal('DLG11-1026-069943');
  });

  it('does not fall back to an internal code when a store has no configured prefix', async () => {
    const service = Object.assign(Object.create(OrderService.prototype), {
      storeRepo: {findOne: async () => ({id: 'store', code: 'ST008'})},
    }) as OrderService;
    await expect(
      service.allocateInvoiceNumber({} as any, 'store'),
    ).to.be.rejectedWith(/store prefix/);
  });
});

describe('invoice numbering entry points', () => {
  const actor = '11111111-1111-4111-8111-111111111111';

  it('uses the ticket store for an automatic invoice, including a gateway callback', async () => {
    const tx = {commit: async () => undefined, rollback: async () => undefined};
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {beginTransaction: async () => tx, execute: async () => []},
      orderRepo: {
        findOne: async () => ({
          id: 'order',
          storeId: 'store-1',
          status: 'received_at_store',
          totalAmount: 100,
        }),
      },
      computeBalanceDue: async () => ({due: 0, alreadyPaid: 100}),
      invoiceRepo: {findOne: async () => null, create: async (row: any) => row},
      challanRepo: {
        findOne: async () => ({id: 'challan', generatedBy: actor}),
        updateById: async () => undefined,
      },
      orderItemRepo: {find: async () => []},
      allocateInvoiceNumber: async (transaction: any, storeId: string) => {
        expect(transaction).to.equal(tx);
        expect(storeId).to.equal('store-1');
        return 'DLG11-1026-069943';
      },
    }) as OrderService;
    const invoice = await service.generateInvoiceForOrder(
      'order',
      'system',
      true,
    );
    expect(invoice?.invoiceNumber).to.equal('DLG11-1026-069943');
  });

  it('preserves a saved legacy invoice when payment updates it', async () => {
    const existing = {id: 'invoice', invoiceNumber: 'ST008/069942'};
    let patch: any;
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {
        beginTransaction: async () => ({
          commit: async () => undefined,
          rollback: async () => undefined,
        }),
        execute: async () => [],
      },
      orderRepo: {
        findOne: async () => ({id: 'order', storeId: 'store', status: 'ready'}),
      },
      computeBalanceDue: async () => ({due: 0, alreadyPaid: 100}),
      invoiceRepo: {
        findOne: async () => existing,
        findById: async () => existing,
        updateById: async (_id: string, value: any) => {
          patch = value;
        },
      },
      allocateInvoiceNumber: async () => {
        throw new Error('Existing invoices must not allocate a new number');
      },
    }) as OrderService;
    expect(
      (await service.generateInvoiceForOrder('order', actor, true))
        ?.invoiceNumber,
    ).to.equal('ST008/069942');
    expect(patch).to.eql({amountReceived: 100, balanceDue: 0});
  });

  it('uses the representative ticket store for an existing consolidated-invoice flow', async () => {
    const tx = {commit: async () => undefined, rollback: async () => undefined};
    const controller = Object.assign(
      Object.create(CustomerBillingController.prototype),
      {
        customerRepo: {
          findOne: async () => ({
            id: 'customer',
            isOnAccountEligible: true,
            invoiceSpanDays: 30,
          }),
        },
        orderRepo: {
          find: async () => [
            {
              id: 'order',
              storeId: 'store-1',
              status: 'ready',
              isOnAccount: true,
              totalAmount: 100,
              taxAmount: 10,
            },
          ],
        },
        invoiceRepo: {find: async () => [], create: async (row: any) => row},
        invoiceOrderLinkRepo: {
          find: async () => [],
          create: async () => undefined,
        },
        paymentRepo: {find: async () => []},
        storeScopeService: {resolve: async () => ({global: true}), allows: () => true},
        dataSource: {beginTransaction: async () => tx, execute: async () => []},
        orderService: {
          allocateInvoiceNumber: async (transaction: any, storeId: string) => {
            expect(transaction).to.equal(tx);
            expect(storeId).to.equal('store-1');
            return 'DLG11-1026-069943';
          },
        },
      },
    ) as CustomerBillingController;
    const result = (await controller.generateOnAccountInvoice(
      {[securityId]: actor} as UserProfile,
      'customer',
      {orderIds: ['order']},
    )) as any;
    expect(result.invoice.invoiceNumber).to.equal('DLG11-1026-069943');
    expect(result.invoice).to.containEql({
      subtotal: 90, discount: 0, cgst: 5, sgst: 5, totalAmount: 100,
    });
  });
});
