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
        orderRepo: {findOne: async () => ({id: 'order-1'})},
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
    const invoice = {
      id: 'invoice-a',
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
        garmentRepo: {find: async () => []},
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
      subtotal: 170,
      totalAmount: 170,
      balanceDue: 170,
    });
    expect(linkUpdate).to.containEql({orderTotal: 70});
    expect(returnUpdate).to.containEql({invoiceId: invoice.id});
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
