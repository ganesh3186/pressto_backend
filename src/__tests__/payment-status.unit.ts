import {expect} from '@loopback/testlab';
import {resolveOrderPaymentStatus} from '../utils/payment-status';

describe('order payment status', () => {
  it('marks coupon-covered active orders paid', () => {
    expect(resolveOrderPaymentStatus(0, 0, 'confirmed')).to.equal('paid');
    expect(resolveOrderPaymentStatus(0, 0, 'draft')).to.equal('pending');
  });

  it('uses collected money for cancelled orders', () => {
    expect(resolveOrderPaymentStatus(0, 0, 'cancelled')).to.equal('unpaid');
    expect(resolveOrderPaymentStatus(100, 25, 'cancelled')).to.equal('paid');
  });
});
