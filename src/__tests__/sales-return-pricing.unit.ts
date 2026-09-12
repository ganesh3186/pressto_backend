import {expect} from '@loopback/testlab';
import {
  calculateDiscountedSalesReturnAmount,
  calculateSalesReturnCreditAmount,
} from '../controllers/sales-return.controller';
import {
  calculateMeasurementPieceBasePrice,
  calculateReturnedPieceValue,
} from '../services/approval.service';

describe('sales return pricing', () => {
  it('includes GST when the order is fully paid', () => {
    expect(calculateSalesReturnCreditAmount(100, 18, true)).to.equal(118);
  });

  it('reduces only the item price when the order is unpaid', () => {
    expect(calculateSalesReturnCreditAmount(100, 18, false)).to.equal(100);
  });

  it('allocates the order discount proportionally to the returned item', () => {
    expect(calculateDiscountedSalesReturnAmount(20, 100, 10)).to.equal(18);
  });

  it('applies the order discount before allocating tax to a returned piece', () => {
    expect(calculateReturnedPieceValue(192, 384, 76.8, 55.3)).to.equal(181.25);
  });

  it('uses the measured piece value when reducing a measurement return', () => {
    expect(calculateMeasurementPieceBasePrice(20, 5, 5, true)).to.equal(500);
  });
});
