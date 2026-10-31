import {expect} from '@loopback/testlab';
import {OrderService} from '../services/order.service';

describe('Manage Ticket invoice filter', () => {
  it('matches invoice numbers and consolidated links before pagination, within store scope', async () => {
    let listing: Record<string, unknown> | undefined;
    let counted: unknown;
    const service = Object.assign(Object.create(OrderService.prototype), {
      invoiceRepo: {find: async (filter: object) => {
        expect(filter).to.eql({
          where: {invoiceNumber: {ilike: '%ST008/069942%'}},
          fields: {id: true, orderId: true},
        });
        return [{id: 'invoice-1', orderId: 'order-1'}];
      }},
      invoiceOrderLinkRepo: {find: async (filter: object) => {
        expect(filter).to.eql({
          where: {invoiceId: {inq: ['invoice-1']}}, fields: {orderId: true},
        });
        return [{orderId: 'order-1'}, {orderId: 'order-2'}];
      }},
      orderRepo: {
        find: async (filter: Record<string, unknown>) => {listing = filter; return [];},
        count: async (where: unknown) => {counted = where; return {count: 0};},
      },
    }) as OrderService;
    await service.listOrders({invoiceNumber: ' ST008/069942 ', storeIds: ['store-1'], limit: 10, skip: 10});
    const expectedWhere = {and: [
      {isDeleted: false}, {storeId: {inq: ['store-1']}},
      {id: {inq: ['order-1', 'order-2']}},
    ]};
    expect(listing?.where).to.eql(expectedWhere);
    expect(counted).to.eql(expectedWhere);
    expect(listing?.limit).to.equal(10);
    expect(listing?.skip).to.equal(10);
  });

  it('returns no tickets when an invoice number does not match', async () => {
    const service = Object.assign(Object.create(OrderService.prototype), {
      invoiceRepo: {find: async () => []},
      orderRepo: {find: async () => {throw new Error('Must not list all orders');}},
    }) as OrderService;
    expect(await service.listOrders({invoiceNumber: 'missing'})).to.eql({rows: [], total: 0});
  });

  it('ignores an empty invoice search', async () => {
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderRepo: {
        find: async (filter: {where: object}) => {
          expect(filter.where).to.eql({isDeleted: false});
          return [];
        },
        count: async () => ({count: 0}),
      },
    }) as OrderService;
    expect(await service.listOrders({invoiceNumber: '  '})).to.eql({rows: [], total: 0});
  });

  it('passes the invoice filter into backend export queries', async () => {
    const service = Object.assign(Object.create(OrderService.prototype), {
      listOrders: async (params: {invoiceNumber?: string; storeIds?: string[]}) => {
        expect(params.invoiceNumber).to.equal('DLG11-1026-069943');
        expect(params.storeIds).to.eql(['store-1']);
        return {rows: [], total: 0};
      },
    }) as OrderService;
    expect(await service.exportOrders({invoiceNumber: 'DLG11-1026-069943'}, ['store-1'])).to.eql({rows: [], total: 0});
  });
});
