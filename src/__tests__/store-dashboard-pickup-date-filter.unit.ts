import {expect} from '@loopback/testlab';
import {StoreDashboardService} from '../services/store-dashboard.service';

describe('store dashboard pickup date filter', () => {
  it('applies the selected dates to the badge count and pickup page', async () => {
    const from = new Date('2026-10-20T00:00:00Z');
    const to = new Date('2026-10-20T23:59:59Z');
    const queries: {sql: string; values: unknown[]}[] = [];
    const service = Object.assign(
      Object.create(StoreDashboardService.prototype),
      {
        dataSource: {
          execute: async (sql: string, values: unknown[]) => {
            queries.push({sql, values});
            return [];
          },
        },
      },
    ) as StoreDashboardService;

    await service.live(['store-1'], {from, to}, 10, {
      tickets: false,
      pickups: true,
      deliveries: false,
      riders: false,
      collected: false,
      handover: false,
    });

    expect(queries).to.have.length(2);
    expect(queries[0].sql).to.match(
      /AND pr\.requesteddate BETWEEN \$\d+ AND \$\d+/,
    );
    expect(queries[1].sql).to.match(
      /AND pr\.requesteddate BETWEEN \$\d+ AND \$\d+/,
    );
    expect(
      queries.every(({values}) => values.includes(from) && values.includes(to)),
    ).to.be.true();
  });
});
