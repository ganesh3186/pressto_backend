import {securityId, UserProfile} from '@loopback/security';
import {expect} from '@loopback/testlab';
import {OrderController} from '../controllers/order.controller';
import {StoreScopeService} from '../services/store-scope.service';

const ORDER_STORE = 'store-a';
const ROUTE_RAN = 'route ran';

const user = (fields: object) =>
  ({[securityId]: 'user-1', id: 'user-1', name: 'Staff', ...fields}) as unknown as UserProfile;

// Anything past the store check throws this, so a test can tell the route body
// ran, and a denied caller can be shown to have changed or read nothing.
const reached = async () => {
  throw new Error(ROUTE_RAN);
};

function buildController(transferGrantsOrder = false) {
  const storeScopeService = Object.assign(
    Object.create(StoreScopeService.prototype),
    {
      orderRepo: {findOne: async () => ({id: 'order-1', storeId: ORDER_STORE})},
      orderItemRepo: {
        find: async () => (transferGrantsOrder ? [{id: 'item-1'}] : []),
      },
      garmentRepo: {find: async () => [{activeTransferId: 'transfer-1'}]},
      transferRepo: {findOne: async () => ({id: 'transfer-1'})},
    },
  );
  return Object.assign(Object.create(OrderController.prototype), {
    storeScopeService,
    orderService: {
      getHandover: reached,
      getOrderDetails: reached,
      correctPaymentMode: reached,
      getActivityLog: reached,
      handoverInStore: reached,
      returnDeliveryToStore: reached,
      splitOrder: reached,
      previewWalletFullPaymentDiscount: reached,
    },
    orderRepository: {
      findOne: async () => ({id: 'order-1', status: 'processing'}),
      updateById: reached,
    },
    statusHistoryRepository: {find: reached},
  }) as OrderController;
}

const routes: {name: string; call: (c: OrderController, u: UserProfile) => Promise<unknown>}[] = [
  {name: 'GET /orders/{id}/handover', call: (c, u) => c.getHandover(u, 'order-1')},
  {name: 'GET /orders/{id}/payments', call: (c, u) => c.getPayments(u, 'order-1')},
  {
    name: 'PATCH /orders/{id}/payments/{paymentId}',
    call: (c, u) =>
      c.correctPaymentMode(u, 'order-1', 'payment-1', {
        paymentMode: 'cash' as never,
        reason: 'Recorded wrongly',
      }),
  },
  {name: 'GET /orders/{id}/status-history', call: (c, u) => c.statusHistory(u, 'order-1')},
  {name: 'GET /orders/{id}/activity-log', call: (c, u) => c.activityLog(u, 'order-1')},
  {
    name: 'POST /orders/{id}/handover',
    call: (c, u) => c.handover(u, 'order-1', {collectorType: 'self' as never}),
  },
  {
    name: 'POST /orders/{id}/delivery-return',
    call: (c, u) => c.deliveryReturn(u, 'order-1', {remarks: 'Customer away'}),
  },
  {
    name: 'POST /orders/{id}/split',
    call: (c, u) => c.splitOrder(u, 'order-1', {garmentIds: ['garment-1']}),
  },
  {
    name: 'GET /orders/{id}/wallet-full-payment-preview',
    call: (c, u) => c.walletFullPaymentPreview(u, 'order-1'),
  },
  {name: 'DELETE /orders/{id}', call: (c, u) => c.deleteById(u, 'order-1')},
];

describe('order routes respect store scope', () => {
  for (const {name, call} of routes) {
    describe(name, () => {
      it('returns 404 and does nothing for another store', async () => {
        const caller = user({roles: ['store_manager'], storeScope: ['store-b']});
        await expect(call(buildController(), caller)).to.be.rejectedWith(/Order not found/);
      });

      it('returns 404 for a caller with no stores', async () => {
        const caller = user({roles: ['store_manager'], storeScope: []});
        await expect(call(buildController(), caller)).to.be.rejectedWith(/Order not found/);
      });

      it('allows a store role when one of its stores owns the order', async () => {
        const caller = user({roles: ['store_manager'], storeScope: ['store-b', ORDER_STORE]});
        await expect(call(buildController(), caller)).to.be.rejectedWith(ROUTE_RAN);
      });

      it('allows a cluster or region role whose stores include the order', async () => {
        const stores = ['store-b', 'store-c', 'store-d', ORDER_STORE];
        const caller = user({roles: ['region_manager'], storeScope: stores});
        await expect(call(buildController(), caller)).to.be.rejectedWith(ROUTE_RAN);
      });

      it('allows an all-stores role', async () => {
        for (const role of ['super_admin', 'pulse_finance', 'md_ceo']) {
          await expect(call(buildController(), user({roles: [role]}))).to.be.rejectedWith(ROUTE_RAN);
        }
      });

      it('allows a store holding one of its garments through a transfer', async () => {
        const caller = user({roles: ['store_manager'], storeScope: ['store-b']});
        await expect(call(buildController(true), caller)).to.be.rejectedWith(ROUTE_RAN);
      });
    });
  }
});
