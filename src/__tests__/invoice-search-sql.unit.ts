import {DefaultCrudRepository, juggler} from '@loopback/repository';
import {securityId, UserProfile} from '@loopback/security';
import {expect} from '@loopback/testlab';
import {InvoiceController} from '../controllers/invoice.controller';
import {Invoice} from '../models/invoice.model';
import {StoreScopeService} from '../services/store-scope.service';

const user = (fields: object) =>
  ({[securityId]: 'user-1', id: 'user-1', ...fields}) as unknown as UserProfile;

const allStores = user({roles: ['super_admin']});
const oneStore = user({roles: ['store_manager'], storeScope: ['store-1']});

describe('invoice list search and type filter', () => {
  // The real Postgres connector builds the SQL. It never opens a connection
  // because every query goes through the execute stub below.
  const dataSource = new juggler.DataSource({
    name: 'invoiceSearchTest',
    connector: 'postgresql',
    lazyConnect: true,
  });

  before(() => {
    // Registers the Invoice model on the connector so buildWhere can map columns.
    return new DefaultCrudRepository<Invoice, string>(Invoice, dataSource).modelClass;
  });

  function buildController(matchedOrderIds: string[] = [], matchedCustomers = 0) {
    const probes: {sql: string; params: unknown[]}[] = [];
    const lookups: {sql: string; params: unknown[]}[] = [];
    const executed: {sql: string; params: unknown[]}[] = [];
    const repoCalls: string[] = [];
    const notUsed = (name: string) => ({
      find: async () => {
        repoCalls.push(name);
        return [];
      },
    });
    const controller = Object.assign(
      Object.create(InvoiceController.prototype),
      {
        storeScopeService: Object.assign(
          Object.create(StoreScopeService.prototype),
          {transferGrantedOrderIds: async () => []},
        ),
        _enrichInvoices: async (invoices: Invoice[]) => invoices,
        orderRepo: notUsed('order'),
        customerRepo: notUsed('customer'),
        usersRepo: notUsed('users'),
        invoiceRepo: {
          entityClass: Invoice,
          find: async (filter: {where: {id?: {inq: string[]}}}) =>
            (filter.where.id?.inq ?? []).map(id => ({id})),
          count: async () => ({count: 99}),
        },
        dataSource: {
          connector: dataSource.connector,
          execute: async (sql: string, params: unknown[]) => {
            if (sql.includes('isconsolidated')) return [];
            if (sql.includes('SELECT 1 FROM public.customer c')) {
              probes.push({sql, params});
              return Array.from({length: matchedCustomers}, () => ({}));
            }
            if (sql.includes('UNION ALL')) {
              lookups.push({sql, params});
              return matchedOrderIds.map(id => ({id}));
            }
            executed.push({sql, params});
            return sql.includes('count(*)') ? [{count: 7}] : [];
          },
        },
      },
    ) as InvoiceController;
    return {controller, executed, lookups, probes, repoCalls};
  }

  const orderIds = (count: number) =>
    Array.from({length: count}, (_, n) => `order-${n}`);

  describe('search', () => {
    it('passes specific matches as one array parameter, not an IN list', async () => {
      const ids = orderIds(50000);
      const {controller, executed} = buildController(ids);
      await controller.find(allStores, 'sharma', 10, 0);

      expect(executed[0].sql).to.containEql(
        '(i.invoicenumber ILIKE $1 OR i.orderid = ANY($2::uuid[]))',
      );
      expect(executed[0].sql).to.not.match(/ IN \(/);
      // Pattern, ids, limit and skip: 4 parameters however many orders matched.
      expect(executed[0].params).to.eql(['%sharma%', ids, 10, 0]);
    });

    it('falls back to a per-invoice check above the list cap', async () => {
      const {controller, executed} = buildController(orderIds(50001));
      await controller.find(allStores, 'sharma', 10, 0);

      expect(executed[0].sql).to.containEql('EXISTS (SELECT 1 FROM public.orders o');
      expect(executed[0].sql).to.containEql('o.id = i.orderid');
      expect(executed[0].sql).to.not.containEql('ANY(');
      expect(executed[0].params).to.eql([
        '%sharma%',
        '%sharma%',
        '%sharma%',
        '%sharma%',
        10,
        0,
      ]);
    });

    it('stops the order lookup just past the list cap', async () => {
      const {controller, lookups} = buildController();
      await controller.find(allStores, 'sharma');
      expect(lookups[0].sql).to.match(/LIMIT 50001\s*$/);
    });

    it('skips the order lookup for a 1-2 character term matching many customers', async () => {
      for (const term of ['m', 'an']) {
        const {controller, executed, lookups, probes} = buildController([], 5001);
        await controller.find(allStores, term, 10, 0);

        expect(probes[0].params).to.eql([`%${term}%`]);
        expect(probes[0].sql).to.match(/LIMIT 5001\s*$/);
        expect(lookups).to.have.length(0);
        expect(executed[0].sql).to.containEql('o.id = i.orderid');
      }
    });

    it('still looks up orders for a rare 1-2 character term', async () => {
      // The per-invoice check would walk every invoice to fill a page.
      const {controller, executed, lookups} = buildController([], 5000);
      await controller.find(allStores, 'qz', 10, 0);

      expect(lookups).to.have.length(1);
      expect(executed[0].sql).to.containEql('i.orderid = ANY($2::uuid[])');
    });

    it('checks each invoice for a short term matching many orders but few customers', async () => {
      const {controller, executed, lookups} = buildController(orderIds(50001), 3);
      await controller.find(allStores, '12', 10, 0);

      expect(lookups).to.have.length(1);
      expect(executed[0].sql).to.containEql('o.id = i.orderid');
    });

    it('does not check customer density for 3 or more characters', async () => {
      const {controller, probes} = buildController();
      await controller.find(allStores, 'sha');
      expect(probes).to.have.length(0);
    });

    it('searches invoice number, order number, customer name and phone', async () => {
      const {controller, executed, lookups} = buildController();
      await controller.find(allStores, '98765');

      expect(executed[0].sql).to.containEql('i.invoicenumber ILIKE');
      expect(lookups[0].sql).to.containEql('o.ordernumber ILIKE $1');
      expect(lookups[0].sql).to.containEql('c.firstname ILIKE $1 OR c.lastname ILIKE $1');
      expect(lookups[0].sql).to.containEql('u.phone LIKE $2');
      expect(lookups[0].params).to.eql(['%98765%', '%98765%']);
    });

    it('matches the phone on digits only', async () => {
      const {controller, lookups} = buildController();
      await controller.find(allStores, '+91 98765');
      expect(lookups[0].params).to.eql(['%+91 98765%', '%9198765%']);
    });

    it('skips the phone match below 3 digits', async () => {
      const {controller, lookups} = buildController();
      await controller.find(allStores, 'a12');
      expect(lookups[0].sql).to.not.containEql('u.phone');
      expect(lookups[0].params).to.eql(['%a12%']);
    });

    it('includes the phone match in the per-invoice check', async () => {
      const {controller, executed} = buildController(orderIds(50001));
      await controller.find(allStores, '987');

      expect(executed[0].sql).to.containEql('OR u.phone LIKE');
      expect(executed[0].params).to.eql(['%987%', '%987%', '%987%', '%987%', '%987%']);
    });

    it('leaves out the users join in the per-invoice check without digits', async () => {
      const {controller, executed} = buildController(orderIds(50001));
      await controller.find(allStores, 'sharma');
      expect(executed[0].sql).to.not.containEql('public.users');
    });

    it('does not repeat an order matched more than one way', async () => {
      const {controller, executed} = buildController(['order-1', 'order-1', 'order-2']);
      await controller.find(allStores, 'sharma');
      expect(executed[0].params[1]).to.eql(['order-1', 'order-2']);
    });

    it('still finds an invoice number when no order matches', async () => {
      const {controller, executed} = buildController([]);
      await controller.find(allStores, 'INV-1');
      expect(executed[0].params).to.eql(['%INV-1%', []]);
    });

    it('ignores a blank search', async () => {
      const {controller, executed, lookups} = buildController();
      expect(await controller.count(allStores, '   ')).to.eql({count: 99});
      expect(lookups).to.have.length(0);
      expect(executed).to.have.length(0);
    });

    it('never loads orders, customers or users into Node', async () => {
      const {controller, repoCalls} = buildController(['order-1']);
      await controller.find(allStores, 'sharma', 10, 0, undefined, 'onAccount');
      await controller.count(allStores, 'sharma', undefined, 'onAccount');
      expect(repoCalls).to.eql([]);
    });

    it('counts a search only up to the cap', async () => {
      const {controller, executed} = buildController();
      expect(await controller.count(allStores, 'sharma')).to.eql({count: 7});

      expect(executed[0].sql).to.match(
        /SELECT count\(\*\)::int AS count FROM \(SELECT 1 FROM public\.invoice i WHERE .* LIMIT \$3\) matches/,
      );
      expect(executed[0].params[2]).to.equal(1000);
    });

    it('stays within the caller\'s stores', async () => {
      const {controller, executed} = buildController(['order-1']);
      await controller.find(oneStore, 'sharma', 10, 0);

      expect(executed[0].sql).to.containEql(
        '(i.invoicenumber ILIKE $1 OR i.orderid = ANY($2::uuid[])) AND i.orderid IN (SELECT o.id FROM public.orders o WHERE o.storeid = ANY($3) OR o.id = ANY($4))',
      );
      expect(executed[0].params).to.eql(['%sharma%', ['order-1'], ['store-1'], [], 10, 0]);
    });

    it('runs no search for a caller with no stores', async () => {
      const {controller, executed, lookups} = buildController(['order-1']);
      const noStores = user({roles: ['store_manager'], storeScope: []});

      expect(await controller.find(noStores, 'sharma')).to.eql([]);
      expect(await controller.count(noStores, 'sharma')).to.eql({count: 0});
      expect(lookups).to.have.length(0);
      expect(executed).to.have.length(0);
    });
  });

  describe('type filter', () => {
    it('matches on-account invoices inside the SQL', async () => {
      const {controller, executed} = buildController();
      await controller.find(allStores, undefined, 10, 0, undefined, 'onAccount');

      expect(executed[0].sql).to.containEql(
        "WHERE EXISTS (SELECT 1 FROM public.orders o JOIN public.customer c ON c.id = o.customerid WHERE o.id = i.orderid AND (c.customerentitytype = 'business' OR c.isonaccounteligible = true))",
      );
      expect(executed[0].params).to.eql([10, 0]);
    });

    it('treats regular as the opposite of on-account', async () => {
      const {controller, executed} = buildController();
      await controller.find(allStores, undefined, 10, 0, undefined, 'regular');
      expect(executed[0].sql).to.containEql('WHERE NOT EXISTS (SELECT 1 FROM public.orders o');
    });

    it('keeps the exact count without a search', async () => {
      const {controller, executed} = buildController();
      await controller.count(allStores, undefined, undefined, 'regular');

      expect(executed[0].sql).to.match(/^SELECT count\(\*\)::int AS count FROM public\.invoice i WHERE NOT EXISTS/);
      expect(executed[0].sql).to.not.containEql('LIMIT');
    });

    it('ignores an unknown type', async () => {
      const {controller, executed} = buildController();
      await controller.find(allStores, undefined, 10, 0, undefined, 'other');
      expect(executed).to.have.length(0);
    });
  });

  it('lines up every parameter when all the filters are combined', async () => {
    const {controller, executed} = buildController(['order-1']);
    await controller.find(oneStore, 'sharma', 10, 20, 'issued', 'regular', '2026-11-01');
    await controller.count(oneStore, 'sharma', 'issued', 'regular', '2026-11-01');

    const [page, count] = executed;
    expect(page.params.slice(0, -2)).to.eql(count.params.slice(0, -1));
    expect(page.params.slice(-2)).to.eql([10, 20]);
    expect(count.params[count.params.length - 1]).to.equal(1000);

    for (const {sql, params} of executed) {
      expect(sql).to.not.containEql('?');
      const placeholders = new Set(sql.match(/\$\d+/g));
      expect(placeholders.size).to.equal(params.length);
    }
  });
});
