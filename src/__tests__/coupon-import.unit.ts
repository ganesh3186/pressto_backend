import {expect} from '@loopback/testlab';
import {CouponController} from '../controllers/coupon.controller';
import {parseCouponImportRow} from '../controllers/coupon-import';

const validRow = {
  code: ' welcome10 ',
  name: 'Welcome offer',
  discountType: 'percentage',
  discountValue: '10',
  startDate: '2026-11-01',
  endDate: '2026-11-30',
};

describe('coupon bulk import', () => {
  it('normalizes a valid row and rejects invalid dates and values', () => {
    const valid = parseCouponImportRow(validRow);
    expect(valid.errors).to.eql([]);
    expect(valid.coupon.code).to.equal('WELCOME10');
    expect(valid.coupon.discountValue).to.equal(10);

    const invalid = parseCouponImportRow({
      ...validRow,
      discountValue: '110',
      endDate: '2026-11-31',
    });
    expect(invalid.errors).to.containEql('discountValue cannot exceed 100%');
    expect(invalid.errors).to.containEql(
      'endDate must be a valid YYYY-MM-DD date',
    );
  });

  it('reports duplicate rows and creates nothing when any row is invalid', async () => {
    let creates = 0;
    const controller = Object.assign(
      Object.create(CouponController.prototype),
      {
        couponRepository: {
          find: async () => [],
          createAll: async () => {
            creates++;
          },
        },
        dataSource: {
          beginTransaction: async () => {
            throw new Error('transaction should not start');
          },
        },
      },
    ) as CouponController;
    const result = await controller.validateBulk({
      rows: [validRow, {...validRow, code: 'WELCOME10'}],
    });
    expect(result.valid).to.equal(false);
    expect(result.errors[0].row).to.equal(3);
    await expect(
      controller.uploadBulk({id: 'admin'} as never, {
        rows: [validRow, {...validRow, code: 'WELCOME10'}],
      }),
    ).to.be.rejectedWith(/duplicated/);
    expect(creates).to.equal(0);
  });

  it('commits all valid coupons in one transaction', async () => {
    let committed = false;
    let saved: object[] = [];
    const tx = {
      commit: async () => {
        committed = true;
      },
      rollback: async () => {
        throw new Error('unexpected rollback');
      },
    };
    const controller = Object.assign(
      Object.create(CouponController.prototype),
      {
        couponRepository: {
          find: async () => [],
          createAll: async (
            rows: object[],
            options: {transaction: unknown},
          ) => {
            expect(options.transaction).to.equal(tx);
            saved = rows;
          },
        },
        dataSource: {beginTransaction: async () => tx},
      },
    ) as CouponController;
    const result = await controller.uploadBulk({id: 'admin'} as never, {
      rows: [validRow],
    });
    expect(result.count).to.equal(1);
    expect(saved).to.have.length(1);
    expect(committed).to.equal(true);
  });
});
