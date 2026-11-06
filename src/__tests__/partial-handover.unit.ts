/* eslint-disable @typescript-eslint/no-explicit-any -- Transactional repository doubles. */
import {expect} from '@loopback/testlab';
import {OrderService} from '../services/order.service';
import {HandoverCollectorType} from '../models/order-handover.model';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function setup(rider = false) {
  let state: any = {
    orders: [{id: 'order', customerId: 'customer', status: rider ? 'out_for_delivery' : 'ready',
      totalAmount: 1000, isDeleted: false}],
    items: [{id: 'item', orderId: 'order'}],
    garments: [
      {id: 'old-piece', orderItemId: 'item', status: 'delivered', isDeleted: false, activeTransferId: null},
      {id: 'ready-piece', orderItemId: 'item', status: rider ? 'out_for_delivery' : 'ready', isDeleted: false, activeTransferId: null},
    ],
    handovers: [{id: 'existing', orderId: 'order', collectorType: 'contact', collectorName: 'Previous Collector',
      collectorPhone: '1111111111', customerContactId: 'old-contact', familyGroupMemberId: 'old-family',
      collectorRelationship: 'brother', photoMediaId: 'old-photo', handedOverBy: 'old-staff',
      handedOverAt: '2026-01-24T13:57:04.000Z', remarks: 'Original partial collection', isDeleted: false}],
    history: [], garmentHistory: [], audits: [], contacts: [],
    approvals: [], stops: rider ? [{id: 'stop', orderId: 'order', deliveryId: 'run', status: 'arrived'}] : [],
  };
  const notifications: unknown[][] = [];
  let queue = Promise.resolve();
  let failAt = '';
  const matches = (row: any, where: any): boolean => Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (value && typeof value === 'object') {
      if (value.inq) return value.inq.includes(row[key]);
      if (value.nin) return !value.nin.includes(row[key]);
      if ('neq' in value) return row[key] !== value.neq;
    }
    return row[key] === value;
  });
  const repo = (name: string) => ({
    find: async (filter: any) => copy(state[name].filter((row: any) => matches(row, filter?.where))),
    findOne: async (filter: any) => copy(state[name].find((row: any) => matches(row, filter?.where)) ?? null),
    findById: async (id: string) => copy(state[name].find((row: any) => row.id === id)),
    create: async (row: any, options: any) => {
      expect(options.transaction.locked).to.equal(true);
      if (failAt === name) throw new Error('Simulated ' + name + ' failure');
      state[name].push(copy(row));
      return copy(row);
    },
    updateById: async (id: string, patch: any, options: any) => {
      expect(options.transaction.locked).to.equal(true);
      Object.assign(state[name].find((row: any) => row.id === id), copy(patch));
    },
  });
  const service = Object.assign(Object.create(OrderService.prototype), {
    orderRepo: repo('orders'), orderItemRepo: repo('items'), garmentRepo: repo('garments'),
    orderHandoverRepo: repo('handovers'), statusHistoryRepo: repo('history'),
    garmentStatusHistoryRepo: repo('garmentHistory'), auditLogRepo: repo('audits'),
    approvalRequestRepo: repo('approvals'), deliveryOrderRepo: repo('stops'),
    customerContactRepo: repo('contacts'),
    customerRepo: {findOne: async () => ({firstName: 'Current', lastName: 'Customer'})},
    userRepo: {findOne: async () => ({fullName: 'Current Employee'})},
    dataSource: {
      beginTransaction: async () => {
        const tx: any = {locked: false};
        tx.commit = async () => {tx.done = true; tx.release?.();};
        tx.rollback = async () => {if (tx.snapshot) state = tx.snapshot; tx.release?.();};
        return tx;
      },
      execute: async (sql: string, _params: unknown[], options: any) => {
        const tx = options.transaction;
        if (sql.includes('public.orders') && !tx.locked) {
          const previous = queue;
          queue = new Promise<void>(resolve => {tx.release = resolve;});
          await previous;
          tx.locked = true;
          tx.snapshot = copy(state);
        }
        return [];
      },
    },
    notifyStatusChange: (...args: unknown[]) => notifications.push(args),
  }) as OrderService;
  const params = {orderId: 'order', collectorType: HandoverCollectorType.OTHER,
    collectorName: 'New Collector', collectorPhone: '2222222222', handedOverBy: 'current-staff', remarks: 'Remaining items collected'};
  const collect = () => rider ? service.recordDeliveryHandover({...params, deliveryId: 'run'}) : service.handoverInStore(params);
  return {service, collect, params, state: () => state, notifications, fail: (name: string) => {failAt = name;}};
}

describe('completion after a partial handover', () => {
  it('updates the current collector and retains the previous snapshot while completing only remaining pieces', async () => {
    const test = setup();
    const previous = copy(test.state().handovers[0]);
    const deliveredPiece = copy(test.state().garments[0]);
    const result = await test.collect() as any;
    expect(result.garmentsDelivered).to.equal(1);
    expect(test.state().handovers).to.have.length(1);
    expect(test.state().handovers[0]).to.containEql({id: 'existing', collectorName: 'New Collector',
      handedOverBy: 'current-staff', remarks: 'Remaining items collected', customerContactId: null,
      familyGroupMemberId: null, photoMediaId: null, collectorRelationship: null});
    expect(test.state().handovers[0].handedOverAt).not.to.equal(previous.handedOverAt);
    expect(test.state().audits[0].before).to.eql(previous);
    expect(test.state().audits[0].after.garmentIds).to.eql(['ready-piece']);
    expect(test.state().garments[0]).to.eql(deliveredPiece);
    expect(test.state().garments[1].status).to.equal('delivered');
    expect(test.state().orders[0]).to.containEql({status: 'delivered', totalAmount: 1000});
    expect(test.notifications).to.have.length(1);
    expect(test.notifications[0][3]).to.equal('collected');
    const latest = await test.service.getHandover('order') as any;
    expect(latest.collectorName).to.equal('New Collector');
    expect(latest.handedOverByName).to.equal('Current Employee');
    expect(latest.isInStoreHandover).to.equal(true);
  });

  it('creates a first handover normally when no earlier record exists', async () => {
    const test = setup(); test.state().handovers = [];
    await test.collect();
    expect(test.state().handovers).to.have.length(1);
    expect(test.state().orders[0].status).to.equal('delivered');
    expect(test.state().audits).to.have.length(0);
  });

  it('rejects rider delivery completion when the stop is pending handover', async () => {
    const test = setup(true);
    test.state().stops[0].status = 'handover_pending';
    const previous = copy(test.state());
    await expect(test.collect()).to.be.rejectedWith(/delivery stop is no longer available/);
    expect(test.state()).to.eql(previous);
    expect(test.notifications).to.have.length(0);
  });

  it('does not soft-delete records or conflict with an already archived handover', async () => {
    const test = setup();
    test.state().handovers.push({...copy(test.state().handovers[0]), id: 'archived', isDeleted: true});
    await test.collect();
    expect(test.state().handovers).to.have.length(2);
    expect(test.state().handovers.find((row: any) => row.id === 'archived').collectorName).to.equal('Previous Collector');
  });

  it('rejects duplicate completion, including when concurrent staff submit together', async () => {
    const test = setup();
    const results = await Promise.allSettled([test.collect(), test.collect()]);
    expect(results.filter(row => row.status === 'fulfilled')).to.have.length(1);
    expect(test.state().audits).to.have.length(1);
    expect(test.state().garmentHistory).to.have.length(1);
    expect(test.notifications).to.have.length(1);
  });

  for (const status of ['in_process', 'on_hold']) {
    it('preserves the original handover when a remaining garment is ' + status, async () => {
      const test = setup(); test.state().garments[1].status = status;
      const previous = copy(test.state());
      await expect(test.collect()).to.be.rejectedWith(/must be ready/);
      expect(test.state()).to.eql(previous);
      expect(test.notifications).to.have.length(0);
    });
  }

  it('does not treat returned or damaged garments as items still awaiting collection', async () => {
    for (const status of ['returned_to_customer', 'damaged']) {
      const test = setup(); test.state().garments[1].status = status;
      await expect(test.collect()).to.be.rejectedWith(/already been handed over/);
      expect(test.state().handovers[0].collectorName).to.equal('Previous Collector');
    }
  });

  it('blocks pending damage approvals and garments still away in transfer', async () => {
    const pending = setup(); pending.state().approvals.push({type: 'item_damaged', status: 'pending', entityType: 'garment', entityId: 'ready-piece'});
    await expect(pending.collect()).to.be.rejectedWith(/pending damage approval/);
    const away = setup(); away.state().garments[1].activeTransferId = 'transfer';
    await expect(away.collect()).to.be.rejectedWith(/Still away/);
  });

  it('retains the old handover if the new collector is invalid', async () => {
    const test = setup();
    await expect(test.service.handoverInStore({...test.params, collectorName: ''})).to.be.rejectedWith(/name of the person/);
    expect(test.state().handovers[0].collectorName).to.equal('Previous Collector');
  });

  for (const point of ['audits', 'history', 'garmentHistory']) {
    it('rolls back collector, order and garment updates after a ' + point + ' failure', async () => {
      const test = setup(); const previous = copy(test.state()); test.fail(point);
      await expect(test.collect()).to.be.rejectedWith(/Simulated/);
      expect(test.state()).to.eql(previous);
      expect(test.notifications).to.have.length(0);
    });
  }

  it('also completes a rider handover and its delivery stop in the same transaction', async () => {
    const test = setup(true);
    await test.collect();
    expect(test.state().orders[0].status).to.equal('delivered');
    expect(test.state().stops[0].status).to.equal('delivered');
    expect(test.state().audits[0].after.channel).to.equal('rider');
    expect(test.notifications[0][3]).to.equal('delivered');
    await expect(test.collect()).to.be.rejectedWith(/already been handed over/);
  });

  it('rejects a superseded rider run without replacing its collector', async () => {
    const test = setup(true); test.state().stops[0].deliveryId = 'different-run';
    await expect(test.collect()).to.be.rejectedWith(/delivery stop/);
    expect(test.state().handovers[0].collectorName).to.equal('Previous Collector');
  });
});
