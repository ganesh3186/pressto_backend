import {expect} from '@loopback/testlab';
import {ShiftController} from '../controllers/shift.controller';
import {SystemNotificationController} from '../controllers/system-notification.controller';
import {SalesReturnStatus} from '../models/sales-return.model';
import {orderListCountCache, OrderService} from '../services/order.service';
import {ShortLivedCache} from '../utils/short-lived-cache';

describe('request load', () => {
  describe('ShortLivedCache', () => {
    it('shares one load between callers until the entry expires', async () => {
      let time = 0;
      let loads = 0;
      const cache = new ShortLivedCache<number>(1000, 10, () => time);
      const load = async () => ++loads;

      expect(await Promise.all([cache.get('a', load), cache.get('a', load)])).to.eql([1, 1]);
      time = 999;
      expect(await cache.get('a', load)).to.equal(1);
      time = 1000;
      expect(await cache.get('a', load)).to.equal(2);
    });

    it('does not keep a failed load', async () => {
      const cache = new ShortLivedCache<number>(1000, 10);
      await expect(cache.get('a', () => Promise.reject(new Error('down')))).to.be.rejectedWith('down');
      expect(await cache.get('a', async () => 1)).to.equal(1);
    });

    it('drops the oldest entry when full', async () => {
      const cache = new ShortLivedCache<string>(1000, 2);
      await cache.get('a', async () => 'first');
      await cache.get('b', async () => 'b');
      await cache.get('c', async () => 'c');
      expect(await cache.get('a', async () => 'reloaded')).to.equal('reloaded');
    });
  });

  describe('order list count', () => {
    it('counts once per scope across repeated polls', async () => {
      orderListCountCache.clear();
      let counts = 0;
      const service = Object.assign(Object.create(OrderService.prototype), {
        orderRepo: {
          find: async () => [],
          count: async () => {
            counts += 1;
            return {count: 7};
          },
        },
      }) as OrderService;

      expect((await service.listOrders({})).total).to.equal(7);
      expect((await service.listOrders({})).total).to.equal(7);
      expect(counts).to.equal(1);

      await service.listOrders({status: 'ready'} as never);
      expect(counts).to.equal(2);
      orderListCountCache.clear();
    });
  });

  describe('shift sales returns', () => {
    const resolve = (controller: object, from: Date, to: Date) =>
      (
        controller as unknown as {
          resolveSalesReturn: (
            storeId: string,
            from: Date,
            to: Date,
          ) => Promise<{pressto: {tickets: number}}>;
        }
      ).resolveSalesReturn('store-a', from, to);

    it('filters by status, store and window in SQL, and loads nothing else when empty', async () => {
      const from = new Date('2026-10-01T00:00:00Z');
      const to = new Date('2026-10-02T00:00:00Z');
      const calls: {sql: string; params: unknown[]}[] = [];
      let finds = 0;
      const controller = Object.assign(Object.create(ShiftController.prototype), {
        salesReturnRepository: {
          execute: async (sql: string, params: unknown[]) => {
            calls.push({sql, params});
            return [];
          },
          find: async () => {
            finds += 1;
            return [];
          },
        },
      });

      const result = await resolve(controller, from, to);

      expect(result.pressto.tickets).to.equal(0);
      expect(finds).to.equal(0);
      expect(calls).to.have.length(1);
      expect(calls[0].params).to.eql([SalesReturnStatus.APPROVED, 'store-a', from, to]);
      expect(calls[0].sql).to.match(/COALESCE\(sr\.resolvedat, sr\.updatedat, sr\.createdat\) BETWEEN \$3 AND \$4/);
      expect(calls[0].sql).to.match(/o\.storeid = \$2/);
    });
  });

  describe('notifications', () => {
    const limitFor = async (filter?: object) => {
      let limit: number | undefined;
      const controller = Object.assign(
        Object.create(SystemNotificationController.prototype),
        {
          systemNotificationRepository: {
            find: async (used: {limit?: number}) => {
              limit = used.limit;
              return [];
            },
            count: async () => ({count: 0}),
          },
        },
      ) as SystemNotificationController;
      await controller.getMyNotifications({id: 'user-a'} as never, filter);
      return limit;
    };

    it('limits the list by default and caps a larger request', async () => {
      expect(await limitFor()).to.equal(200);
      expect(await limitFor({limit: 5000})).to.equal(200);
      expect(await limitFor({limit: 20})).to.equal(20);
    });
  });

  describe('challan auto discount', () => {
    it('reads the discount group on the caller transaction', async () => {
      const options = {transaction: {}};
      let usedOptions: unknown;
      const service = Object.assign(Object.create(OrderService.prototype), {
        customerDiscountGroupRepo: {
          findOne: async (_filter: object, used: unknown) => {
            usedOptions = used;
            return {discountPercentage: 10};
          },
        },
      }) as unknown as {
        resolveCustomerAutoDiscount: (
          subtotal: number,
          customer: object,
          options: object,
        ) => Promise<{discountAmount: number}>;
      };

      const result = await service.resolveCustomerAutoDiscount(
        100,
        {customerGroupId: 'group-a'},
        options,
      );

      expect(result.discountAmount).to.equal(10);
      expect(usedOptions).to.equal(options);
    });
  });
});
