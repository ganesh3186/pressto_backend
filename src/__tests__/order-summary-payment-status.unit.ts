import {expect} from '@loopback/testlab';
import {orderSummaryPaymentStatus} from '../services/order-summary-pdf.service';

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
