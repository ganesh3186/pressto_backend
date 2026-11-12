import {expect} from '@loopback/testlab';
import {securityId, UserProfile} from '@loopback/security';
import {TransferController} from '../controllers/transfer.controller';
import {BagStatus} from '../models/bag-status.enum';
import {TransferStatus} from '../models/transfer-status.enum';

describe('transfer cancellation', () => {
  it('atomically cancels and releases garments, every bag, and the rider', async () => {
    const transfer = {id: 'transfer-1', transitId: 'TR-1', fromStoreId: 'store-1', bagId: 'bag-1', riderId: 'rider-1', status: TransferStatus.IN_TRANSIT};
    const bagUpdates: Array<{id: string; data: object}> = [];
    let garmentUpdate: object | undefined;
    const tx = {commit: async () => undefined, rollback: async () => undefined};
    const controller = Object.assign(Object.create(TransferController.prototype), {
      transferRepo: {
        findOne: async () => transfer,
        updateAll: async (data: object) => { Object.assign(transfer, data); return {count: 1}; },
        findById: async () => transfer,
      },
      transferItemRepo: {find: async () => [{bagId: 'bag-1'}, {bagId: 'bag-2'}]},
      garmentRepo: {updateAll: async (data: object) => { garmentUpdate = data; return {count: 2}; }},
      bagRepo: {updateById: async (id: string, data: object) => { bagUpdates.push({id, data}); }},
      custodyEventRepo: {create: async () => undefined},
      storeScopeService: {resolve: async () => ({global: true}), allows: () => true},
      dataSource: {beginTransaction: async () => tx},
      notificationService: {notifyRider: async () => undefined},
    }) as TransferController;

    const result = await controller.cancel({[securityId]: 'user-1'} as UserProfile, transfer.id) as {transfer: typeof transfer};

    expect(result.transfer.status).to.equal(TransferStatus.CANCELLED);
    expect(result.transfer.riderId).to.equal(null);
    expect(garmentUpdate).to.eql({activeTransferId: null});
    expect(bagUpdates.map(row => row.id)).to.eql(['bag-1', 'bag-2']);
    bagUpdates.forEach(row => expect(row.data).to.containEql({status: BagStatus.AVAILABLE, itemCount: 0, currentTransferId: null, currentStoreId: 'store-1'}));
  });

  it('rolls back a stale receive after cancellation wins the status race', async () => {
    const transfer = {
      id: 'transfer-1',
      fromStoreId: 'store-1',
      toStoreId: 'store-2',
      bagId: 'bag-1',
      status: TransferStatus.IN_TRANSIT,
    };
    let rolledBack = false;
    let custodyWrites = 0;
    const controller = Object.assign(Object.create(TransferController.prototype), {
      transferRepo: {
        findOne: async () => transfer,
        updateAll: async () => ({count: 0}),
      },
      transferItemRepo: {
        find: async () => [{id: 'item-1', garmentId: 'garment-1', orderId: 'order-1', bagId: 'bag-1'}],
        updateById: async () => undefined,
      },
      garmentRepo: {updateById: async () => undefined},
      orderRepo: {find: async () => [{id: 'order-1', storeId: 'store-2'}]},
      custodyEventRepo: {create: async () => { custodyWrites++; }},
      bagRepo: {updateById: async () => undefined},
      storeScopeService: {resolve: async () => ({global: true}), allows: () => true},
      dataSource: {
        beginTransaction: async () => ({
          commit: async () => undefined,
          rollback: async () => { rolledBack = true; },
        }),
      },
    }) as TransferController;

    await expect(controller.receive(
      {[securityId]: 'user-1'} as UserProfile,
      transfer.id,
      {receivedGarmentIds: ['garment-1']},
    )).to.be.rejectedWith(/can no longer be received/);
    expect(rolledBack).to.equal(true);
    expect(custodyWrites).to.equal(0);
  });

  it('does not let the admin test transition revive a cancelled transfer', async () => {
    let rolledBack = false;
    let custodyWrites = 0;
    const controller = Object.assign(Object.create(TransferController.prototype), {
      transferRepo: {
        findOne: async () => ({id: 'transfer-1', status: TransferStatus.RIDER_ASSIGNED}),
        updateAll: async () => ({count: 0}),
      },
      custodyEventRepo: {create: async () => { custodyWrites++; }},
      dataSource: {
        beginTransaction: async () => ({
          commit: async () => undefined,
          rollback: async () => { rolledBack = true; },
        }),
      },
    }) as TransferController;

    await expect(controller.testMarkInTransit(
      {[securityId]: 'user-1'} as UserProfile,
      'transfer-1',
    )).to.be.rejectedWith(/can no longer be marked in transit/);
    expect(rolledBack).to.equal(true);
    expect(custodyWrites).to.equal(0);
  });
});
