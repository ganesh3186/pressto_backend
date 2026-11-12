import {expect} from '@loopback/testlab';
import {
  orderSummaryPaymentStatus,
  requireStoreGstNumber,
} from '../services/order-summary-pdf.service';

describe('order summary payment status', () => {
  it('marks active zero-rupee tickets paid', () => {
    expect(orderSummaryPaymentStatus(0, 0, 'confirmed')).to.equal('Paid');
  });

  it('does not relabel inactive zero-rupee tickets paid', () => {
    expect(orderSummaryPaymentStatus(0, 0, 'draft')).to.equal('Unpaid');
    expect(orderSummaryPaymentStatus(0, 0, 'cancelled')).to.equal('Unpaid');
    expect(orderSummaryPaymentStatus(100, 25, 'cancelled')).to.equal('Paid');
  });
});

describe('order summary store GSTN', () => {
  it('rejects a missing GSTN before generating the PDF', () => {
    expect(() => requireStoreGstNumber({})).to.throw(/Store GSTN is unavailable/);
    expect(() => requireStoreGstNumber({gstNumber: '   '})).to.throw(
      /Store GSTN is unavailable/,
    );
  });

  it('accepts and trims the store GSTN', () => {
    expect(requireStoreGstNumber({gstNumber: ' 27AAECP3228Q2ZX '})).to.equal(
      '27AAECP3228Q2ZX',
    );
  });
});
