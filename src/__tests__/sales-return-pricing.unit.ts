import {expect} from '@loopback/testlab';
import {UserProfile} from '@loopback/security';
import {
  calculateDiscountedSalesReturnAmount,
  calculateSalesReturnCreditAmount,
  SalesReturnController,
} from '../controllers/sales-return.controller';
import {SalesReturnStatus} from '../models/sales-return.model';
import {
  calculateMeasurementPieceBasePrice,
  calculateRemainingOrderTotals,
  calculateReturnedPieceSubtotal,
  calculateReturnedPieceValue,
} from '../services/approval.service';

describe('sales return pricing', () => {
  it('saves the selected garment and tax rates on a new credit note', async () => {
    let saved: Record<string, unknown> | undefined;
    const controller = Object.assign(Object.create(SalesReturnController.prototype), {
      storeScopeService: {assertOrderVisible: async () => {}},
      dataSource: {execute: async () => [{nextNumber: '1'}], beginTransaction: async () => ({commit: async () => {}, rollback: async () => {}})},
      _previewCreditNote: async () => ({refundAmount: 432, newOrderTotal: 654, newBalanceDue: 0}),
      applyCreditNote: async () => {},
      approvalService: {calculateGarmentReturnAmount: async (id: string) => ({itemPrice: 192, additionalServiceCharge: id === 'garment-2' ? 201 : 402, addOnCharge: 0})},
      orderRepo: {findOne: async () => ({id: 'order-1', customerId: 'customer-1',
        status: 'ready', subtotal: 987, discountAmount: 0, taxAmount: 98.7, totalAmount: 1086})},
      orderItemRepo: {find: async () => [{id: 'shirts', quantity: 2}]},
      salesReturnRepo: {find: async () => [], count: async () => ({count: 0}), findById: async () => saved,
        create: async (value: Record<string, unknown>) => { saved = value; return value; }},
      garmentRepo: {find: async () => [
        {id: 'garment-1', orderItemId: 'shirts', status: 'delivered'},
        {id: 'garment-2', orderItemId: 'shirts', status: 'delivered'},
      ]},
      orderService: {getOrderDetails: async () => ({items: [{id: 'shirts',
        itemName: 'Shirt', serviceName: 'Clean', unitPrice: 192,
        garments: [{id: 'garment-1', additionalServices: [{amount: 402}]},
          {id: 'garment-2', additionalServices: [{amount: 201}]}]}]})},
      gstConfigRepo: {findOne: async () => ({cgstPercentage: 5, sgstPercentage: 5})},
      invoiceRepo: {findOne: async () => ({id: 'invoice-1', status: 'issued', subtotal: 987, totalAmount: 1086, cgst: 49.35, sgst: 49.35, items: [{orderItemId: 'shirts', quantity: 2, totalPrice: 987}]})},
      invoiceOrderLinkRepo: {findOne: async () => null},
      _isOrderPaid: async () => true,
    }) as SalesReturnController;
    await controller.create({} as UserProfile, 'order-1', {reason: 'Return', returnedItems: [
      {orderItemId: 'shirts', garmentId: 'garment-2', quantity: 1, amount: 393},
    ]});
    const line = (saved?.returnedItems as Array<Record<string, unknown>>)[0];
    expect(line.garmentId).to.equal('garment-2');
    expect(line.garmentSnapshot).to.containEql({id: 'garment-2'});
    expect(line).to.containEql({cgstRate: 5, sgstRate: 5});
    expect(saved?.creditAmount).to.equal(432);
  });

  it('shows a refund preview for every pending note on a ticket', async () => {
    const controller = Object.assign(Object.create(SalesReturnController.prototype), {
      storeScopeService: {assertOrderVisible: async () => {}},
      salesReturnRepo: {find: async () => [
        {id: 'newer', orderId: 'order-1', status: SalesReturnStatus.PENDING, creditAmount: 20},
        {id: 'older', orderId: 'order-1', status: SalesReturnStatus.PENDING, creditAmount: 10},
      ]},
      orderRepo: {findById: async () => ({id: 'order-1', totalAmount: 100})},
      paymentRepo: {find: async () => [{transactionType: 'payment', amount: 100}]},
      refundDueRepo: {find: async () => []},
    }) as SalesReturnController;
    const result = await controller.listSalesReturns('order-1', {} as UserProfile) as {
      salesReturns: Array<{id: string; refundAmount: number}>;
    };
    expect(result.salesReturns.map(note => [note.id, note.refundAmount]))
      .to.deepEqual([['newer', 20], ['older', 10]]);
  });

  it('rejects a second sales return for an approved damaged garment', async () => {
    const controller = Object.assign(
      Object.create(SalesReturnController.prototype),
      {
        storeScopeService: {assertOrderVisible: async () => {}},
        dataSource: {
          execute: async () => [],
          beginTransaction: async () => ({
            commit: async () => {},
            rollback: async () => {},
          }),
        },
        invoiceRepo: {
          findOne: async () => ({id: 'invoice-1', status: 'issued'}),
        },
        orderRepo: {findOne: async () => ({id: 'order-1', status: 'ready'})},
        orderItemRepo: {
          find: async () => [{id: 'item-1', itemId: 'catalog-1', quantity: 1}],
        },
        salesReturnRepo: {find: async () => []},
        garmentRepo: {
          find: async () => [{orderItemId: 'item-1', status: 'damaged'}],
        },
        itemRepo: {find: async () => [{id: 'catalog-1', name: 'Shirt'}]},
      },
    ) as SalesReturnController;

    try {
      await controller.create({} as UserProfile, 'order-1', {
        reason: 'Damaged',
        returnedItems: [{orderItemId: 'item-1', quantity: 1, amount: 252}],
      });
      throw new Error('Expected a conflicting sales return');
    } catch (error) {
      expect((error as {statusCode?: number}).statusCode).to.equal(409);
    }
  });

  it('updates only the returned order share of a consolidated on-account invoice', async () => {
    let invoiceUpdate: Record<string, unknown> | undefined;
    let linkUpdate: Record<string, unknown> | undefined;
    let returnUpdate: Record<string, unknown> | undefined;
    let returnedGarmentId: string | undefined;
    const invoice = {
      id: 'invoice-a',
      status: 'issued',
      isConsolidated: true,
      subtotal: 200,
      totalAmount: 200,
      balanceDue: 200,
    };
    const controller = Object.assign(
      Object.create(SalesReturnController.prototype),
      {
        salesReturnRepo: {
          findById: async () => ({
            id: 'return-b',
            orderId: 'order-b',
            status: SalesReturnStatus.PENDING,
            creditAmount: 30,
            returnedItems: [
              {
                orderItemId: 'item-b',
                garmentId: 'garment-b',
                quantity: 1,
                amount: 30,
                originalAmount: 30,
              },
            ],
          }),
          updateById: async (_id: string, value: Record<string, unknown>) => {
            returnUpdate = value;
          },
          find: async () => [],
        },
        orderRepo: {
          findOne: async () => ({
            id: 'order-b',
            status: 'ready',
            subtotal: 100,
            discountAmount: 0,
            totalAmount: 118,
          }),
          updateById: async () => {},
        },
        invoiceRepo: {
          findOne: async () => null,
          findById: async () => invoice,
          updateById: async (_id: string, value: Record<string, unknown>) => {
            invoiceUpdate = value;
          },
        },
        invoiceOrderLinkRepo: {
          findOne: async () => ({
            id: 'link-b',
            invoiceId: invoice.id,
            orderId: 'order-b',
            orderTotal: 100,
          }),
          updateById: async (_id: string, value: Record<string, unknown>) => {
            linkUpdate = value;
          },
        },
        storeScopeService: {assertOrderVisible: async () => {}},
        dataSource: {
          execute: async () => [],
          beginTransaction: async () => ({
            commit: async () => {},
            rollback: async () => {},
          }),
        },
        garmentRepo: {
          findOne: async () => ({id: 'garment-b', status: 'delivered'}),
          find: async (filter: {where: {id?: string}}) =>
            filter.where.id === 'garment-b' ? [{id: 'garment-b', status: 'delivered'}] : [],
          updateById: async (id: string) => { returnedGarmentId = id; },
        },
        challanRepo: {findOne: async () => null},
        orderItemRepo: {find: async () => []},
        _previewCreditNote: async () => ({
          newOrderTotal: 88,
          refundAmount: 0,
          newBalanceDue: 88,
        }),
        _resolveGstRate: async () => 18,
      },
    ) as SalesReturnController;

    await controller.approve({} as UserProfile, 'return-b');
    expect(invoiceUpdate).to.containEql({
      balanceDue: 170,
    });
    expect(invoice.totalAmount).to.equal(200);
    expect(linkUpdate).to.containEql({orderTotal: 70});
    expect(returnUpdate).to.containEql({invoiceId: invoice.id});
    expect(returnedGarmentId).to.equal('garment-b');
  });

  it('includes GST when the order is fully paid', () => {
    expect(calculateSalesReturnCreditAmount(100, 18, true)).to.equal(118);
  });

  it('does not include GST when the order is unpaid', () => {
    expect(calculateSalesReturnCreditAmount(100, 18, false)).to.equal(100);
  });

  it('allocates the order discount proportionally to the returned item', () => {
    expect(calculateDiscountedSalesReturnAmount(20, 100, 10)).to.equal(18);
  });

  it('returns the discounted item plus GST on a paid discounted order', () => {
    const discounted = calculateDiscountedSalesReturnAmount(200, 1000, 100);
    expect(calculateSalesReturnCreditAmount(discounted, 18, true)).to.equal(
      212.4,
    );
  });

  it('applies the order discount before allocating tax to a returned piece', () => {
    expect(calculateReturnedPieceValue(192, 384, 76.8, 55.3)).to.equal(181.25);
  });

  it('uses the measured piece value when reducing a measurement return', () => {
    expect(calculateMeasurementPieceBasePrice(20, 5, 5, true)).to.equal(500);
  });

  it('returns item, services, and add-ons plus GST for a paid order', () => {
    const itemAndCharges = calculateReturnedPieceSubtotal(100, [20], [10], 0);
    expect(calculateSalesReturnCreditAmount(itemAndCharges, 18, true)).to.equal(
      153.4,
    );
  });

  it('returns discounted item, services, and add-ons without GST for an unpaid order', () => {
    const itemAndCharges = calculateReturnedPieceSubtotal(100, [20], [10], 0);
    const discounted = calculateDiscountedSalesReturnAmount(
      itemAndCharges,
      1000,
      100,
    );
    expect(calculateSalesReturnCreditAmount(discounted, 18, false)).to.equal(
      117,
    );
  });

  it('includes garment services and add-on charges in the returned subtotal', () => {
    expect(calculateReturnedPieceSubtotal(192, [200], [], 0)).to.equal(392);
  });

  it('includes an allocated legacy line-level add-on in the returned subtotal', () => {
    const allocatedLineCharge = 200 / 2;
    expect(
      calculateReturnedPieceSubtotal(192, [100], [allocatedLineCharge], 0),
    ).to.equal(392);
  });

  it('applies delivery uplift to services but not fixed add-on charges', () => {
    expect(calculateReturnedPieceSubtotal(192, [100], [50], 20)).to.equal(362);
  });

  it('returns the complete garment subtotal plus its GST share', () => {
    const subtotal = calculateReturnedPieceSubtotal(192, [200], [], 0);
    expect(calculateReturnedPieceValue(subtotal, 584, 0, 105.12)).to.equal(
      462.56,
    );
  });

  it('deducts the returned garment discount before adding GST', () => {
    const subtotal = calculateReturnedPieceSubtotal(192, [200], [], 0);
    expect(calculateReturnedPieceValue(subtotal, 584, 58.4, 94.61)).to.equal(
      416.31,
    );
  });

  it('rebuilds the remaining order from only the surviving ₹192 item', () => {
    expect(calculateRemainingOrderTotals(192, 0.1, 0.18)).to.eql({
      subtotal: 192,
      discount: 19.2,
      tax: 31.1,
      total: 204,
    });
  });
});
