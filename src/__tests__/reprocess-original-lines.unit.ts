import {expect} from '@loopback/testlab';
import {OrderService} from '../services/order.service';

describe('reprocess original piece count', () => {
  it('uses the approved garments, not the edited order quantity', async () => {
    const service = Object.assign(Object.create(OrderService.prototype), {
      approvalRequestRepo: {
        find: async () => [{metadata: {reworkOrderId: 'rework', garmentIds: ['original-garment']}}],
      },
      orderItemRepo: {
        find: async () => [{id: 'original-item', serviceId: 'clean', itemId: 'shirt', additionalServiceIds: ['starch']}],
      },
      garmentRepo: {
        find: async () => [{id: 'original-garment', orderItemId: 'original-item'}],
      },
    });

    const lines = await service.getReprocessOriginalLines({id: 'rework', reprocessOfOrderId: 'original'});
    expect(lines.get('clean::shirt')).to.eql({quantity: 1, additionalServiceIds: ['starch']});
  });
});
