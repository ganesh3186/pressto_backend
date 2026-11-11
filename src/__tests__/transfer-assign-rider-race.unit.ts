import {expect} from '@loopback/testlab';
import {securityId, UserProfile} from '@loopback/security';
import {TransferController} from '../controllers/transfer.controller';
import {TransferStatus} from '../models/transfer-status.enum';

describe('transfer rider assignment concurrency', () => {
  it('updates only a still-assignable transfer', async () => {
    let updateWhere: Record<string, unknown> | undefined;
    const controller = Object.assign(Object.create(TransferController.prototype), {
      transferRepo: {
        findOne: async () => ({
          id: 'transfer-1',
          fromStoreId: 'store-1',
          status: TransferStatus.RIDER_ASSIGNED,
          riderId: 'old-rider',
          riderAssignedAt: new Date('2026-11-11T10:00:00.000Z'),
        }),
        updateAll: async (
          _data: Record<string, unknown>,
          where: Record<string, unknown>,
        ) => {
          updateWhere = where;
          return {count: 1};
        },
        findById: async () => ({id: 'transfer-1', riderId: 'new-rider'}),
      },
      storeScopeService: {resolve: async () => ({}), allows: () => true},
      assertRiderAssignable: async () => ({id: 'new-rider', firstName: 'New', lastName: 'Rider'}),
      dataSource: {
        beginTransaction: async () => ({commit: async () => {}, rollback: async () => {}}),
      },
      custodyEventRepo: {create: async () => ({})},
      notificationService: {notifyRider: async () => {}},
    }) as TransferController;

    await controller.assignRider(
      {[securityId]: 'admin-1'} as UserProfile,
      'transfer-1',
      {riderId: 'new-rider'},
    );

    expect(updateWhere).to.deepEqual({
      id: 'transfer-1',
      status: TransferStatus.RIDER_ASSIGNED,
      riderId: 'old-rider',
      riderAssignedAt: new Date('2026-11-11T10:00:00.000Z'),
      isDeleted: false,
    });
  });
});
