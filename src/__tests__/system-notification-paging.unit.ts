import {expect} from '@loopback/testlab';
import {SystemNotificationController} from '../controllers/system-notification.controller';

type Row = {id: string; userId: string; status: number; isDeleted: boolean; template: string};

// Minimal in-memory repository: supports the where shapes the controller
// builds ({and: [...]} and equality filters), limit and skip.
function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  if (Array.isArray(where.and)) return (where.and as Record<string, unknown>[]).every(w => matches(row, w));
  return Object.entries(where).every(([key, value]) => (row as Record<string, unknown>)[key] === value);
}

function buildController(rows: Row[]) {
  const repo = {
    find: async (filter: {where?: Record<string, unknown>; limit?: number; skip?: number}) => {
      const found = rows.filter(r => matches(r, filter.where));
      const start = filter.skip ?? 0;
      return filter.limit != null ? found.slice(start, start + filter.limit) : found.slice(start);
    },
    count: async (where: Record<string, unknown>) => ({count: rows.filter(r => matches(r, where)).length}),
  };
  return Object.assign(Object.create(SystemNotificationController.prototype), {
    systemNotificationRepository: repo,
  }) as SystemNotificationController;
}

const me = {id: 'me'} as never;
const rows: Row[] = [
  ...Array.from({length: 250}, (_, i) => ({
    id: `n${i}`, userId: 'me', status: i < 200 ? 0 : 1, isDeleted: false, template: i % 2 ? 'order_ready' : 'order_created',
  })),
  {id: 'deleted', userId: 'me', status: 0, isDeleted: true, template: 'order_ready'},
  {id: 'other', userId: 'someone-else', status: 0, isDeleted: false, template: 'order_ready'},
];

describe('GET /system-notifications paging', () => {
  const controller = buildController(rows);

  it('returns one page with the real unread and total counts', async () => {
    const res = await controller.getMyNotifications(me, {limit: 20, skip: 0});
    expect(res.notifications).to.have.length(20);
    expect(res.unreadCount).to.equal(200);
    expect(res.allCount).to.equal(250);
    expect(res.totalCount).to.equal(250);
  });

  it('counts only the notifications matching the filter, for paging', async () => {
    const unread = await controller.getMyNotifications(me, {where: {status: 0}, limit: 25, skip: 175});
    expect(unread.totalCount).to.equal(200);
    expect(unread.notifications).to.have.length(25);
    const readyUnread = await controller.getMyNotifications(me, {where: {and: [{status: 0}, {template: 'order_ready'}]}, limit: 10});
    expect(readyUnread.totalCount).to.equal(100);
    expect(readyUnread.allCount).to.equal(250);
  });

  it('never returns more than 200 in one request, with or without a limit', async () => {
    expect((await controller.getMyNotifications(me, {limit: 5000})).notifications).to.have.length(200);
    const unlimited = await controller.getMyNotifications(me, undefined);
    expect(unlimited.notifications).to.have.length(200);
    expect(unlimited.totalCount).to.equal(250);
  });
});
