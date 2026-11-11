import {expect} from '@loopback/testlab';
import {securityId, UserProfile} from '@loopback/security';
import {RiderTransferController} from '../controllers/rider-transfer.controller';
import {TransferStatus} from '../models/transfer-status.enum';

describe('rider transfer item verification', () => {
  it('keeps the manifest count and records the rider verified shortage', async () => {
    let saved: Record<string, unknown> | undefined;
    let updateWhere: Record<string, unknown> | undefined;
    let lookupWhere: Record<string, unknown> | undefined;
    const events: Array<Record<string, unknown>> = [];
    const controller = Object.assign(Object.create(RiderTransferController.prototype), {
      resolveActiveRider: async () => ({id: 'rider-1', isActive: true}),
      transferRepository: {
        findOne: async (filter: {where: Record<string, unknown>}) => {
          lookupWhere = filter.where;
          return {
          id: 'transfer-1',
          riderId: 'rider-1',
          status: TransferStatus.RIDER_ASSIGNED,
          bagId: 'bag-1',
          itemCount: 24,
          };
        },
        updateAll: async (data: Record<string, unknown>, where: Record<string, unknown>) => {
          saved = data;
          updateWhere = where;
          return {count: 1};
        },
      },
      transferItemRepository: {
        find: async () => [{bagId: 'bag-1'}],
      },
      bagRepository: {find: async () => []},
      custodyEventRepository: {
        create: async (event: Record<string, unknown>) => { events.push(event); },
      },
      dataSource: {
        beginTransaction: async () => ({commit: async () => {}, rollback: async () => {}}),
      },
    }) as RiderTransferController;
    const user = {[securityId]: 'user-1'} as UserProfile;

    const result = await controller.startTransit(user, 'transfer-1', {
      status: TransferStatus.IN_TRANSIT,
      bagIds: ['bag-1'],
      itemCount: 20,
    });

    expect(saved).to.containDeep({
      status: TransferStatus.IN_TRANSIT,
      riderVerifiedItemCount: 20,
    });
    expect(updateWhere).to.containDeep({
      id: 'transfer-1',
      riderId: 'rider-1',
      status: TransferStatus.RIDER_ASSIGNED,
      isDeleted: false,
    });
    expect(lookupWhere).to.deepEqual({transitId: 'transfer-1', isDeleted: false});
    expect(result).to.containDeep({
      expectedItemCount: 24,
      riderVerifiedItemCount: 20,
      shortageCount: 4,
    });
    expect(events[events.length - 1]?.remarks).to.equal('Rider verified 20 of 24 item(s).');

    const legacyResult = await controller.startTransit(user, 'transfer-1', {
      status: TransferStatus.IN_TRANSIT,
      bagIds: ['bag-1'],
    });
    expect(saved).to.not.have.property('riderVerifiedItemCount');
    expect(legacyResult).to.containDeep({riderVerifiedItemCount: null, shortageCount: null});
    expect(events[events.length - 1]?.remarks)
      .to.equal('Rider started transit without submitting an item count; manifest has 24 item(s).');
  });
});
