import {expect} from '@loopback/testlab';
import {OrderStatus} from '../models/order-status.enum';
import {ReprocessReason} from '../models/reprocess-reason.enum';
import {ReprocessService} from '../services/reprocess.service';

describe('reprocess delivery date', () => {
  it('saves a future promise on the approval request and rejects a past one', async () => {
    let metadata: Record<string, unknown> = {};
    const service = Object.assign(Object.create(ReprocessService.prototype), {
      orderRepo: {
        findOne: async () => ({id: 'order-1', status: OrderStatus.DELIVERED}),
        findById: async () => ({id: 'order-1', status: OrderStatus.DELIVERED}),
      },
      dataSource: {
        beginTransaction: async () => ({commit: async () => {}, rollback: async () => {}}),
        execute: async () => [{id: 'order-1'}],
      },
      approvalService: {
        createRequest: async (input: {metadata: Record<string, unknown>}) => {
          metadata = input.metadata;
          return {id: 'approval-1', metadata: {...input.metadata, reworkOrderId: 'ticket-1'}};
        },
        notifyReprocessPickupRequired: async () => {},
      },
      statusHistoryRepo: {create: async () => ({})},
      assertWithinWindow: async () => {},
      resolveGarmentIds: async () => ['garment-1'],
      assertNoActiveReworkTicket: async () => {},
    }) as ReprocessService;
    const input = {
      orderId: 'order-1',
      reason: ReprocessReason.OTHER,
      remarks: 'Stain remains',
      requestedBy: 'staff-1',
      source: 'store' as const,
    };
    const deliveryDate = new Date(Date.now() + 86400000).toISOString();

    const result = await service.raiseRequest({...input, deliveryDate}) as {request: {metadata: Record<string, unknown>}};
    expect(metadata.deliveryDate).to.equal(deliveryDate);
    expect(result.request.metadata.reworkOrderId).to.equal('ticket-1');

    await expect(
      service.raiseRequest({...input, deliveryDate: new Date(0).toISOString()}),
    ).to.be.rejectedWith(/future delivery date and time/);
  });
});
