import {UserProfile} from '@loopback/security';
import {expect} from '@loopback/testlab';
import {RiderPerformanceController} from '../controllers/rider-performance.controller';
import {PickupRequestStatus} from '../models/pickup-request-status.enum';

describe('rider dashboard handover counts', () => {
  it('includes early pickups and cash collected from deliveries scheduled for another day', async () => {
    const pickupFilters: Record<string, unknown>[] = [];
    let cashFilter: Record<string, unknown> | undefined;
    const controller = Object.assign(Object.create(RiderPerformanceController.prototype), {
      resolveActiveRider: async () => ({id: 'rider-a'}),
      pickupRequestRepository: {
        find: async ({where}: {where: Record<string, unknown>}) => {
          pickupFilters.push(where);
          return where.status === PickupRequestStatus.PICKED_UP
            ? [{id: 'early-pickup'}, {id: 'batched-pickup'}]
            : [];
        },
      },
      deliveryRepository: {find: async () => []},
      transferRepository: {find: async () => []},
      paymentTransactionRepository: {
        count: async (where: Record<string, unknown>) => {
          cashFilter = where;
          return {count: 1};
        },
      },
      pickupHandoverRepository: {find: async () => [{id: 'pending-batch'}]},
      pickupHandoverItemRepository: {find: async () => [{pickupRequestId: 'batched-pickup'}]},
    }) as RiderPerformanceController;

    const result = (await controller.dashboard({} as UserProfile, '2026-10-13')) as {
      handoverOrdersCount: number;
      handoverCashCount: number;
    };

    expect(pickupFilters[0].requestedDate).to.deepEqual({between: ['2026-10-13', '2026-10-13']});
    expect(pickupFilters[1]).to.deepEqual({
      assignedRiderId: 'rider-a',
      isDeleted: false,
      status: PickupRequestStatus.PICKED_UP,
    });
    expect(cashFilter).to.deepEqual({riderId: 'rider-a', riderHandoverStatus: 'with_rider'});
    expect(result.handoverOrdersCount).to.equal(1);
    expect(result.handoverCashCount).to.equal(1);
  });
});
