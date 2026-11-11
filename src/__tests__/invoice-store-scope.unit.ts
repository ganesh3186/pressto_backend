import {DefaultCrudRepository, juggler} from '@loopback/repository';
import {securityId, UserProfile} from '@loopback/security';
import {expect} from '@loopback/testlab';
import {InvoiceController} from '../controllers/invoice.controller';
import {Invoice} from '../models/invoice.model';
import {StoreScopeService} from '../services/store-scope.service';

const user = (fields: object) =>
  ({[securityId]: 'user-1', id: 'user-1', ...fields}) as unknown as UserProfile;

describe('invoice list store scope', () => {
  // The real Postgres connector builds the SQL. It never opens a connection
  // because every query goes through the execute stub below.
  const dataSource = new juggler.DataSource({
    name: 'invoiceScopeTest',
    connector: 'postgresql',
    lazyConnect: true,
  });

  before(() => {
    // Registers the Invoice model on the connector so buildWhere can map columns.
    return new DefaultCrudRepository<Invoice, string>(Invoice, dataSource).modelClass;
  });

  function buildController(options: {
    rows?: {id: string}[];
    grantedOrderIds?: string[];
    consolidatedOrderIds?: string[];
  } = {}) {
    const lookups: {sql: string; params: unknown[]}[] = [];
    const executed: {sql: string; params: unknown[]}[] = [];
    const repoCalls = {find: 0, count: 0};
    const scopeService = Object.assign(
      Object.create(StoreScopeService.prototype),
      {transferGrantedOrderIds: async () => options.grantedOrderIds ?? [], storeRepo: {find: async () => []}},
    );
    const controller = Object.assign(
      Object.create(InvoiceController.prototype),
      {
        storeScopeService: scopeService,
        _enrichInvoices: async (invoices: Invoice[]) => invoices,
        invoiceRepo: {
          entityClass: Invoice,
          find: async (filter: {where: {id?: {inq: string[]}}}) => {
            repoCalls.find++;
            return (filter.where.id?.inq ?? []).map(id => ({id}));
          },
          count: async () => {
            repoCalls.count++;
            return {count: 99};
          },
        },
        dataSource: {
          connector: dataSource.connector,
          execute: async (sql: string, params: unknown[]) => {
            if (sql.includes('isconsolidated')) {
              lookups.push({sql, params});
              return (options.consolidatedOrderIds ?? []).map(orderid => ({orderid}));
            }
            executed.push({sql, params});
            return sql.includes('count(*)') ? [{count: 7}] : (options.rows ?? []);
          },
        },
      },
    ) as InvoiceController;
    return {controller, executed, lookups, repoCalls};
  }

  it('leaves an all-stores role on the existing query', async () => {
    for (const role of ['super_admin', 'pulse_finance', 'md_ceo']) {
      const {controller, executed, lookups, repoCalls} = buildController();
      const allStores = user({roles: [role]});
      await controller.find(allStores);
      expect(await controller.count(allStores)).to.eql({count: 99});
      expect(executed).to.have.length(0);
      expect(lookups).to.have.length(0);
      expect(repoCalls).to.eql({find: 1, count: 1});
    }
  });

  it('treats a token scoped to every store as all stores', async () => {
    const {controller, executed} = buildController();
    await controller.find(user({roles: ['custom_role'], storeScope: '*'}));
    expect(executed).to.have.length(0);
  });

  it('passes every store of a multi-store, cluster or region role', async () => {
    const storeIds = ['store-1', 'store-2', 'store-3'];
    const {controller, executed} = buildController();
    await controller.find(user({roles: ['area_manager'], storeScope: storeIds}));

    expect(executed).to.have.length(1);
    expect(executed[0].params.filter(Array.isArray)).to.eql([storeIds, []]);
  });

  it('matches invoices through their order, inside the SQL', async () => {
    const {controller, executed} = buildController();
    await controller.find(user({roles: ['store_manager'], storeScope: ['store-1']}));

    expect(executed[0].sql).to.match(
      /i\.orderid IN \(SELECT o\.id FROM public\.orders o WHERE o\.storeid = ANY\(\$1\) OR o\.id = ANY\(\$2\)\)/,
    );
  });

  it('includes a consolidated invoice through its representative order', async () => {
    const {controller, executed, lookups} = buildController({
      consolidatedOrderIds: ['representative-1'],
    });
    await controller.find(user({roles: ['store_manager'], storeScope: ['store-1']}));

    expect(lookups[0].params).to.eql([['store-1'], []]);
    expect(executed[0].params.filter(Array.isArray)).to.eql([
      ['store-1'],
      ['representative-1'],
    ]);
  });

  it('includes orders granted through an active transfer', async () => {
    const {controller, executed, lookups} = buildController({
      grantedOrderIds: ['order-9'],
    });
    await controller.find(user({roles: ['store_manager'], storeScope: ['store-1']}));

    // A transferred order can also bring in the consolidated invoice it is on.
    expect(lookups[0].params).to.eql([['store-1'], ['order-9']]);
    expect(executed[0].params.filter(Array.isArray)).to.eql([['store-1'], ['order-9']]);
  });

  it('does not repeat an order that is both transferred and consolidated', async () => {
    const {controller, executed} = buildController({
      grantedOrderIds: ['order-9'],
      consolidatedOrderIds: ['order-9', 'order-10'],
    });
    await controller.find(user({roles: ['store_manager'], storeScope: ['store-1']}));

    expect(executed[0].params.filter(Array.isArray)[1]).to.eql(['order-9', 'order-10']);
  });

  it('shows nothing and runs no query for a caller with no stores', async () => {
    const {controller, executed, lookups} = buildController();
    const noStores = user({roles: ['store_manager'], storeScope: []});

    expect(await controller.find(noStores)).to.eql([]);
    expect(await controller.count(noStores)).to.eql({count: 0});
    expect(executed).to.have.length(0);
    expect(lookups).to.have.length(0);
  });

  it('keeps the SQL sort order when loading the page', async () => {
    const {controller} = buildController({rows: [{id: 'newest'}, {id: 'older'}]});
    const rows = await controller.find(
      user({roles: ['store_manager'], storeScope: ['store-1']}),
    );
    expect(rows.map(row => (row as Invoice).id)).to.eql(['newest', 'older']);
  });

  it('gives the list and count the same filters and numbered parameters', async () => {
    const {controller, executed} = buildController();
    const caller = user({roles: ['store_manager'], storeScope: ['store-1']});
    const dateFrom = '2026-11-01';

    await controller.find(caller, undefined, 10, 20, 'issued', undefined, dateFrom);
    const total = await controller.count(caller, undefined, 'issued', undefined, dateFrom);
    expect(total).to.eql({count: 7});

    const [page, count] = executed;
    const pageWhere = page.sql.slice(page.sql.indexOf('FROM'), page.sql.indexOf('ORDER BY'));
    const countWhere = count.sql.slice(count.sql.indexOf('FROM'));
    expect(pageWhere.trim()).to.equal(countWhere.trim());
    expect(count.params).to.eql(page.params.slice(0, count.params.length));
    expect(page.params.slice(-2)).to.eql([10, 20]);
    expect(page.params).to.containEql('issued');

    // Every parameter has a placeholder, so nothing shifts into the wrong slot.
    for (const {sql, params} of executed) {
      expect(sql).to.not.containEql('?');
      const placeholders = new Set(sql.match(/\$\d+/g));
      expect(placeholders.size).to.equal(params.length);
    }
  });
});
