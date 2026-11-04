import {expect} from '@loopback/testlab';
import {OrderService} from '../services/order.service';
import {multiStorePaymentFilterFrom} from '../utils/payment-status';

describe('Manage Ticket server payment filtering', () => {
  it('applies payment filtering to page and count queries while retaining store scope', async () => {
    const queries: {sql: string; params: unknown[]}[] = [];
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderRepo: {entityClass: {modelName: 'Order'}},
      dataSource: {
        connector: {
          buildWhere: (_model: string, where: object) => {
            expect(where).to.eql({
              and: [{isDeleted: false}, {storeId: {inq: ['store-1']}}],
            });
            return {
              sql: 'WHERE isdeleted = ? AND storeid = ?',
              params: [false, 'store-1'],
            };
          },
          parameterize: (query: object) => query,
        },
        execute: async (sql: string, params: unknown[]) => {
          queries.push({sql, params});
          return [{count: 45, ids: []}];
        },
      },
    }) as OrderService;
    expect(
      await service.listOrders({
        paymentStatus: 'partial',
        storeIds: ['store-1'],
        limit: 10,
        skip: 50,
      }),
    ).to.eql({rows: [], total: 45});
    expect(queries).to.have.length(1);
    for (const query of queries) {
      expect(query.sql).to.containEql('payment_sums AS');
      expect(query.sql).to.containEql('payment_totals.collected > 0');
      expect(query.params.slice(0, 2)).to.eql([false, 'store-1']);
    }
    expect(queries[0].params.slice(-2)).to.eql([10, 50]);
  });

  it('rejects an unknown payment filter before querying', async () => {
    const service = Object.create(OrderService.prototype) as OrderService;
    await expect(
      service.listOrders({paymentStatus: "partial' OR TRUE --"}),
    ).to.be.rejectedWith('Unsupported payment status filter.');
  });

  describe('export', () => {
    function exportService(matching: string[]) {
      const calls: {
        matchingIdsOnly?: boolean;
        paymentStatus?: string;
        orderIds?: string[];
        storeIds?: string[];
        skip?: number;
      }[] = [];
      const service = Object.assign(Object.create(OrderService.prototype), {
        listOrders: async (params: (typeof calls)[number]) => {
          calls.push(params);
          if (params.matchingIdsOnly) {
            return params.paymentStatus && params.paymentStatus !== 'all'
              ? {rows: [], total: matching.length, orderIds: matching}
              : {rows: [], total: 0};
          }
          return {
            rows: (params.orderIds ?? []).map(() => ({paymentStatus: 'paid'})),
          };
        },
      }) as OrderService;
      return {service, calls};
    }
    const ids = (count: number) =>
      Array.from({length: count}, (_, n) => `order-${n}`);

    it('finds matching orders once, however many batches it loads', async () => {
      const {service, calls} = exportService(ids(250));
      const result = await service.exportOrders({paymentStatus: 'success'}, [
        'store-1',
      ]);

      expect(result.total).to.equal(250);
      expect(calls.filter(call => call.matchingIdsOnly)).to.have.length(1);
      const batches = calls.filter(call => call.orderIds);
      expect(batches.map(call => call.orderIds!.length)).to.eql([100, 100, 50]);
      expect(batches.map(call => call.orderIds![0])).to.eql([
        'order-0',
        'order-100',
        'order-200',
      ]);
    });

    it('keeps the caller store scope on every batch', async () => {
      const {service, calls} = exportService(ids(101));
      await service.exportOrders({paymentStatus: 'partial'}, ['store-1']);
      for (const call of calls) expect(call.storeIds).to.eql(['store-1']);
    });

    it('does not re-run the payment filter while loading batches', async () => {
      const {service, calls} = exportService(ids(101));
      await service.exportOrders({paymentStatus: 'success'}, ['store-1']);
      for (const call of calls.filter(c => c.orderIds)) {
        expect(call.paymentStatus).to.be.undefined();
      }
    });

    it('does not stop early when an order disappears between batches', async () => {
      const {service, calls} = exportService(ids(250));
      const listOrders = service.listOrders.bind(service);
      service.listOrders = (async (params: {orderIds?: string[]}) => {
        const result = await listOrders(params);
        return params.orderIds?.[0] === 'order-0'
          ? {...result, rows: result.rows.slice(1)}
          : result;
      }) as typeof service.listOrders;

      const result = await service.exportOrders({paymentStatus: 'success'}, [
        'store-1',
      ]);
      expect(calls.filter(call => call.orderIds)).to.have.length(3);
      expect(result.total).to.equal(249);
    });

    it('exports nothing and loads no batch when no order matches', async () => {
      const {service, calls} = exportService([]);
      const result = await service.exportOrders({paymentStatus: 'partial'}, [
        'store-1',
      ]);
      expect(result.total).to.equal(0);
      expect(calls.filter(call => call.orderIds)).to.have.length(0);
    });

    it('keeps paging normally without a payment filter', async () => {
      const {service, calls} = exportService([]);
      await service.exportOrders({paymentStatus: 'all'}, ['store-1']);
      expect(calls.filter(call => call.matchingIdsOnly)).to.have.length(1);
      expect(calls[1].skip).to.equal(0);
    });
  });

  describe('multi-store date limit', () => {
    function listService() {
      const wheres: object[] = [];
      const service = Object.assign(Object.create(OrderService.prototype), {
        orderRepo: {
          entityClass: {modelName: 'Order'},
          find: async () => [],
          count: async () => ({count: 0}),
        },
        dataSource: {
          connector: {
            buildWhere: (_model: string, where: object) => {
              wheres.push(where);
              return {sql: 'WHERE TRUE', params: []};
            },
            parameterize: (query: object) => query,
          },
          execute: async () => [{count: 3, ids: []}],
        },
      }) as OrderService;
      return {service, wheres};
    }
    const fromIn = (where: object) =>
      (where as {and: {createdAt?: {gte?: string}}[]}).and.find(
        clause => clause.createdAt?.gte,
      )?.createdAt?.gte;
    const daysAgo = (date: string) =>
      Math.round((Date.now() - new Date(date).getTime()) / 864e5);

    it('limits all stores to 90 days and reports it', async () => {
      const {service, wheres} = listService();
      const result = await service.listOrders({paymentStatus: 'partial', storeIds: null});

      expect(daysAgo(fromIn(wheres[0])!)).to.equal(90);
      expect(result.paymentFilterFrom).to.equal(fromIn(wheres[0]));
    });

    it('limits several stores to 90 days', async () => {
      const {service, wheres} = listService();
      await service.listOrders({paymentStatus: 'partial', storeIds: ['a', 'b']});
      expect(daysAgo(fromIn(wheres[0])!)).to.equal(90);
    });

    it('leaves one store unlimited', async () => {
      const {service, wheres} = listService();
      const result = await service.listOrders({paymentStatus: 'partial', storeIds: ['a']});

      expect(fromIn(wheres[0])).to.be.undefined();
      expect(result.paymentFilterFrom).to.be.undefined();
    });

    it('keeps a start date already inside the limit', async () => {
      const {service, wheres} = listService();
      const dateFrom = new Date(Date.now() - 10 * 864e5).toISOString();
      const result = await service.listOrders({
        paymentStatus: 'partial',
        storeIds: null,
        dateFrom,
      });

      expect(fromIn(wheres[0])).to.equal(dateFrom);
      expect(result.paymentFilterFrom).to.be.undefined();
    });

    it('moves an older start date up to the limit', async () => {
      const {service, wheres} = listService();
      await service.listOrders({
        paymentStatus: 'partial',
        storeIds: null,
        dateFrom: '2020-01-01',
      });
      expect(daysAgo(fromIn(wheres[0])!)).to.equal(90);
    });

    it('measures the limit back from the end date', () => {
      expect(multiStorePaymentFilterFrom('2020-01-01', '2024-06-30T00:00:00.000Z')).to.equal(
        '2024-04-01T00:00:00.000Z',
      );
    });

    it('applies with a search too, but not to cancelled or unfiltered lists', async () => {
      const searched = listService();
      await searched.service.listOrders({
        paymentStatus: 'partial',
        invoiceNumber: 'ST013',
        storeIds: null,
      });
      expect(daysAgo(fromIn(searched.wheres[0])!)).to.equal(90);

      const cancelled = listService();
      const result = await cancelled.service.listOrders({
        paymentStatus: 'cancelled',
        storeIds: null,
      });
      expect(result.paymentFilterFrom).to.be.undefined();
      expect(cancelled.wheres).to.have.length(0);
    });
  });
});
