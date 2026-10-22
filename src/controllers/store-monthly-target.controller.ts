import {authenticate} from '@loopback/authentication';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, post, requestBody, response} from '@loopback/rest';
import {authorize} from '../authorization';
import {StoreMonthlyTarget} from '../models/store-monthly-target.model';
import {StoreMonthlyTargetRepository, StoreRepository} from '../repositories';

type MonthRow = {
  month: number;
  itemTarget: number | null;
  serviceTarget: number | null;
  revenueTarget: number | null;
};

type MonthInput = {
  month: number;
  itemTarget?: number | null;
  serviceTarget?: number | null;
  revenueTarget?: number | null;
};

const MONTHS = Array.from({length: 12}, (_, i) => i + 1);

export class StoreMonthlyTargetController {
  constructor(
    @repository(StoreMonthlyTargetRepository)
    private storeMonthlyTargetRepository: StoreMonthlyTargetRepository,
    @repository(StoreRepository)
    private storeRepository: StoreRepository,
  ) {}

  // Always returns exactly 12 rows (Jan-Dec) for the requested year, filling
  // in null placeholders for any month that has no saved row yet — the
  // frontend's 12-row table never has to handle a partial list.
  @authenticate('jwt')
  @get('/stores/{storeId}/monthly-targets')
  @response(200, {description: "A store's item/service/revenue targets for every month of a year"})
  async find(
    @param.path.string('storeId') storeId: string,
    @param.query.number('year') year?: number,
  ): Promise<{storeId: string; year: number; months: MonthRow[]}> {
    const store = await this.storeRepository.findOne({where: {id: storeId, isDeleted: false}});
    if (!store) throw new HttpErrors.NotFound('Store not found.');

    const targetYear = year ?? new Date().getFullYear();
    const existing = await this.storeMonthlyTargetRepository.find({
      where: {storeId, year: targetYear, isDeleted: false} as object,
    });

    return {storeId, year: targetYear, months: this.fillMonths(existing)};
  }

  // Bulk upsert — the whole 12-row table is saved in one call rather than
  // one request per month. Blocks any year before the current one, same
  // restriction the frontend's year picker already enforces, so a closed
  // period can't be edited via a direct API call either.
  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['store:update']})
  @post('/stores/{storeId}/monthly-targets')
  @response(200, {description: "A store's item/service/revenue targets for every month of a year, after saving"})
  async upsert(
    @param.path.string('storeId') storeId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['year', 'months'],
            properties: {
              year: {type: 'number'},
              months: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['month'],
                  properties: {
                    month: {type: 'number'},
                    itemTarget: {type: 'number', nullable: true},
                    serviceTarget: {type: 'number', nullable: true},
                    revenueTarget: {type: 'number', nullable: true},
                  },
                },
              },
            },
          },
        },
      },
    })
    body: {year: number; months: MonthInput[]},
  ): Promise<{storeId: string; year: number; months: MonthRow[]}> {
    const store = await this.storeRepository.findOne({where: {id: storeId, isDeleted: false}});
    if (!store) throw new HttpErrors.NotFound('Store not found.');

    const year = Number(body.year);
    const currentYear = new Date().getFullYear();
    if (!Number.isInteger(year) || year < currentYear) {
      throw new HttpErrors.BadRequest(`Targets can only be set for ${currentYear} or a later year.`);
    }

    const months = Array.isArray(body.months) ? body.months : [];
    const seenMonths = new Set<number>();
    for (const row of months) {
      const month = Number(row.month);
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        throw new HttpErrors.BadRequest(`Invalid month: ${row.month}`);
      }
      if (seenMonths.has(month)) {
        throw new HttpErrors.BadRequest(`Month ${month} was submitted more than once.`);
      }
      seenMonths.add(month);
      this.assertValidTarget('itemTarget', row.itemTarget);
      this.assertValidTarget('serviceTarget', row.serviceTarget);
      this.assertValidTarget('revenueTarget', row.revenueTarget);
    }

    for (const row of months) {
      const month = Number(row.month);
      const data = {
        itemTarget: row.itemTarget ?? null,
        serviceTarget: row.serviceTarget ?? null,
        revenueTarget: row.revenueTarget ?? null,
      };
      const current = await this.storeMonthlyTargetRepository.findOne({
        where: {storeId, year, month, isDeleted: false} as object,
      });
      if (current) {
        await this.storeMonthlyTargetRepository.updateById(current.id, data);
      } else {
        await this.storeMonthlyTargetRepository.create({storeId, year, month, ...data});
      }
    }

    const saved = await this.storeMonthlyTargetRepository.find({
      where: {storeId, year, isDeleted: false} as object,
    });
    return {storeId, year, months: this.fillMonths(saved)};
  }

  private assertValidTarget(label: string, value: number | null | undefined): void {
    if (value === null || value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new HttpErrors.BadRequest(`${label} must be a non-negative number.`);
    }
  }

  private fillMonths(rows: StoreMonthlyTarget[]): MonthRow[] {
    const byMonth = new Map(rows.map(row => [row.month, row]));
    return MONTHS.map(month => {
      const row = byMonth.get(month);
      return {
        month,
        itemTarget: row?.itemTarget ?? null,
        serviceTarget: row?.serviceTarget ?? null,
        revenueTarget: row?.revenueTarget ?? null,
      };
    });
  }
}
