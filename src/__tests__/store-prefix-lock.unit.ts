import {expect} from '@loopback/testlab';
import {StoreController} from '../controllers/store.controller';
import {OrderService} from '../services/order.service';
import {Store} from '../models/store.model';

describe('store prefix lock', () => {
  it('requires a prefix when creating a store', async () => {
    const controller = Object.assign(Object.create(StoreController.prototype), {
      storeRepository: {
        find: async () => [],
        findOne: async () => null,
      },
    }) as StoreController;

    await expect(controller.create({name: 'New Store', storePrefix: ''} as Store)).to.be.rejectedWith(/prefix is required/i);
  });

  it('rejects a changed prefix after an order exists, even before backfill', async () => {
    const controller = Object.assign(Object.create(StoreController.prototype), {
      storeRepository: {
        findById: async () => ({storePrefix: 'OLD', isPrefixLocked: false}),
      },
      orderRepository: {count: async () => ({count: 1})},
    }) as StoreController;

    await expect(controller.updateById('store-1', {storePrefix: 'NEW'})).to.be.rejectedWith(/locked/);
  });

  it('allows ordinary edits to a locked store while keeping its prefix', async () => {
    let saved: object | undefined;
    const controller = Object.assign(Object.create(StoreController.prototype), {
      storeRepository: {
        findById: async () => ({name: 'Store', storePrefix: 'ABC', isPrefixLocked: true}),
        findOne: async () => null,
        updateById: async (_id: string, data: object) => { saved = data; },
      },
    }) as StoreController;

    await controller.updateById('store-1', {storePrefix: 'ABC', city: 'Mumbai'});
    expect(saved).to.eql({storePrefix: 'ABC', city: 'Mumbai'});
  });

  it('lets a legacy store with no prefix set one once', async () => {
    let saved: object | undefined;
    const controller = Object.assign(Object.create(StoreController.prototype), {
      storeRepository: {
        findById: async () => ({name: 'Store', storePrefix: null, isPrefixLocked: true}),
        findOne: async () => null,
        updateById: async (_id: string, data: object) => { saved = data; },
      },
      orderRepository: {count: async () => ({count: 1})},
    }) as StoreController;

    await controller.updateById('store-1', {storePrefix: 'ABC'});
    expect(saved).to.eql({storePrefix: 'ABC'});
  });

  it('allows editing a store whose unchanged name is duplicated in existing data', async () => {
    let saved: object | undefined;
    const controller = Object.assign(Object.create(StoreController.prototype), {
      storeRepository: {
        findById: async () => ({name: 'Bandra'}),
        findOne: async () => { throw new Error('name lookup should be skipped'); },
        updateById: async (_id: string, data: object) => { saved = data; },
      },
    }) as StoreController;

    await controller.updateById('store-1', {name: 'Bandra', city: 'Mumbai'});
    expect(saved).to.eql({name: 'Bandra', city: 'Mumbai'});
  });

  it('still rejects a name changed to another store name', async () => {
    const controller = Object.assign(Object.create(StoreController.prototype), {
      storeRepository: {
        findById: async () => ({name: 'Original'}),
        findOne: async () => ({id: 'other-store'}),
      },
    }) as StoreController;

    await expect(controller.updateById('store-1', {name: 'Bandra'})).to.be.rejectedWith(/already exists/);
  });

  it('rejects direct or bulk lock changes', async () => {
    const controller = Object.create(StoreController.prototype) as StoreController;
    await expect(controller.updateById('store-1', {isPrefixLocked: false})).to.be.rejectedWith(/cannot be changed directly/);
    await expect(controller.updateAll({storePrefix: 'NEW'} as Store)).to.be.rejectedWith(/cannot be changed in bulk/);
  });

  it('refuses order numbers when the prefix is blank', async () => {
    const service = Object.assign(Object.create(OrderService.prototype), {
      storeRepo: {findOne: async () => ({storePrefix: '   '})},
    }) as OrderService;
    const resolve = service as unknown as {resolveNextOrderNumber: (storeId: string) => Promise<string>};
    await expect(resolve.resolveNextOrderNumber('store-1')).to.be.rejectedWith(/no order number prefix/);
  });

  it('locks the prefix in the order transaction and detects a concurrent edit', async () => {
    const tx = {};
    let count = 1;
    const service = Object.assign(Object.create(OrderService.prototype), {
      storeRepo: {
        updateAll: async (data: object, where: object, options: object) => {
          expect(data).to.eql({isPrefixLocked: true});
          expect(where).to.eql({id: 'store-1', storePrefix: 'ABC'});
          expect(options).to.eql({transaction: tx});
          return {count};
        },
      },
    }) as OrderService;

    const lock = service as unknown as {lockStorePrefix: (storeId: string, orderNumber: string, transaction: object) => Promise<void>};
    await lock.lockStorePrefix('store-1', 'ABC-1026-0001', tx);
    count = 0;
    await expect(lock.lockStorePrefix('store-1', 'ABC-1026-0001', tx)).to.be.rejectedWith(/changed/);
  });
});
