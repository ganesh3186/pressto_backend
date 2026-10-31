import {expect} from '@loopback/testlab';
import {DeliveryStatus} from '../models/delivery-status.enum';
import {WhatsAppService} from '../services/whatsapp.service';

describe('delivery schedule notification', () => {
  it('distinguishes a slot reversal while reusing the key for an identical retry', async () => {
    const delivery = {
      id: 'run-1', status: DeliveryStatus.ASSIGNED,
      assignedAt: new Date('2026-11-01T08:00:00.000Z'),
      deliveryDate: new Date('2026-11-01T00:00:00Z'),
      deliverySlotId: 'slot-1', deliverySlot: '8 AM - 9 AM', riderId: 'rider-1',
    };
    const keys: string[] = [];
    const service = Object.assign(Object.create(WhatsAppService.prototype), {
      configured: () => true,
      attachmentsEnabled: () => true,
      getDeliveries: async () => ({findOne: async () => delivery}),
      getDeliveryOrders: async () => ({find: async () => [{orderId: 'order-1'}]}),
      once: async (key: string) => {keys.push(key); return true;},
    }) as WhatsAppService;

    await service.notifyDeliveryAssigned(delivery.id);
    delivery.assignedAt = new Date('2026-11-01T08:01:00.000Z');
    delivery.deliverySlotId = 'slot-2';
    delivery.deliverySlot = '11 AM - 12 PM';
    await service.notifyDeliveryAssigned(delivery.id);
    delivery.assignedAt = new Date('2026-11-01T08:02:00.000Z');
    delivery.deliverySlotId = 'slot-1';
    delivery.deliverySlot = '8 AM - 9 AM';
    await service.notifyDeliveryAssigned(delivery.id);
    await service.notifyDeliveryAssigned(delivery.id);

    expect(keys).to.have.length(4);
    expect(keys[0]).not.to.equal(keys[1]);
    expect(keys[0]).not.to.equal(keys[2]);
    expect(keys[2]).to.equal(keys[3]);
  });
});
