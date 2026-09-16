import {expect} from '@loopback/testlab';
import {
  calculateDiscountedSalesReturnAmount,
  calculateSalesReturnCreditAmount,
} from '../controllers/sales-return.controller';
import {
  calculateMeasurementPieceBasePrice,
  calculateRemainingOrderTotals,
  calculateReturnedPieceSubtotal,
  calculateReturnedPieceValue,
} from '../services/approval.service';

describe('sales return pricing', () => {
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
    expect(calculateSalesReturnCreditAmount(discounted, 18, true)).to.equal(212.4);
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
    expect(calculateReturnedPieceSubtotal(192, [100], [allocatedLineCharge], 0)).to.equal(392);
  });

  it('applies delivery uplift to services but not fixed add-on charges', () => {
    expect(calculateReturnedPieceSubtotal(192, [100], [50], 20)).to.equal(362);
  });

  it('returns the complete garment subtotal plus its GST share', () => {
    const subtotal = calculateReturnedPieceSubtotal(192, [200], [], 0);
    expect(calculateReturnedPieceValue(subtotal, 584, 0, 105.12)).to.equal(462.56);
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
