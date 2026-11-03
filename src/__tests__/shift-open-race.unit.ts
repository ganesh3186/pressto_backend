import {securityId, UserProfile} from '@loopback/security';
import {expect} from '@loopback/testlab';
import {ShiftController} from '../controllers/shift.controller';
import {ShiftStatus} from '../models/shift-status.enum';

type Row = Record<string, unknown>;
type Tx = {locks: (() => void)[]; pending: (() => void)[]};
type Options = {transaction: Tx};

const nextTick = () => new Promise(resolve => setImmediate(resolve));

const body = (pettyCash = 0) => ({
  remarks: 'Morning count',
  openingBalances: {pettyCash: {actual: pettyCash}} as never,
});

/**
 * A small stand-in for Postgres: rows only appear to others after commit, an
 * advisory lock makes later callers wait until the holder's transaction ends,
 * and every query yields so concurrent calls really interleave.
 */
function buildDatabase(options: {storeOf?: (user: UserProfile) => string; pettyFails?: boolean; useLock?: boolean} = {}) {
  const db = {
    shifts: [] as Row[],
    petty: [] as Row[],
    committed: 0,
    rolledBack: 0,
    lockKeys: [] as unknown[],
    queryOptions: [] as (Options | undefined)[],
  };
  const lockTails = new Map<string, Promise<void>>();
  const finish = (tx: Tx) => tx.locks.splice(0).forEach(release => release());

  const controller = Object.assign(Object.create(ShiftController.prototype), {
    resolveCallerStore: async (user: UserProfile) => ({
      storeId: options.storeOf ? options.storeOf(user) : 'store-1',
      storeCode: 'ST1',
      storeName: 'Store 1',
      userId: user[securityId],
      userName: user.name,
    }),
    resolveSupposedOpeningValues: async () => {
      await nextTick();
      return {pettyCash: 100};
    },
    dataSource: {
      beginTransaction: async () => {
        const tx: Tx = {locks: [], pending: []};
        return {
          ...tx,
          commit: async () => {
            tx.pending.splice(0).forEach(apply => apply());
            db.committed++;
            finish(tx);
          },
          rollback: async () => {
            tx.pending.splice(0);
            db.rolledBack++;
            finish(tx);
          },
        };
      },
      execute: async (sql: string, params: string[], opts: {transaction: {locks: (() => void)[]}}) => {
        expect(sql).to.containEql('pg_advisory_xact_lock');
        db.lockKeys.push(params[0]);
        if (options.useLock === false) return [];
        const previous = lockTails.get(params[0]) ?? Promise.resolve();
        let release = () => {};
        lockTails.set(params[0], previous.then(() => new Promise<void>(resolve => {
          release = resolve;
        })));
        await previous;
        await nextTick();
        opts.transaction.locks.push(() => release());
        return [];
      },
    },
    shiftRepository: {
      findOne: async ({where}: {where: Row}, opts: Options) => {
        db.queryOptions.push(opts);
        await nextTick();
        return db.shifts.find(s => s.storeId === where.storeId && s.status === where.status) ?? null;
      },
      count: async (where: Row, opts: Options) => {
        db.queryOptions.push(opts);
        await nextTick();
        return {count: db.shifts.filter(s => s.storeId === where.storeId).length};
      },
      create: async (row: Row, opts: Options) => {
        db.queryOptions.push(opts);
        await nextTick();
        (opts.transaction.pending ?? []).push(() => db.shifts.push(row));
        return row;
      },
    },
    pettyCashFinanceRepository: {
      create: async (row: Row, opts: Options) => {
        db.queryOptions.push(opts);
        if (options.pettyFails) throw new Error('petty cash write failed');
        opts.transaction.pending.push(() => db.petty.push(row));
        return row;
      },
    },
  }) as ShiftController;

  return {controller, db};
}

const staff = (name: string) => ({[securityId]: name, name}) as unknown as UserProfile;

describe('opening a shift', () => {
  it('lets only one of two simultaneous openings succeed', async () => {
    const {controller, db} = buildDatabase();

    const results = await Promise.allSettled([
      controller.open(staff('Asha'), body()),
      controller.open(staff('Ravi'), body()),
    ]);

    expect(results.filter(r => r.status === 'fulfilled')).to.have.length(1);
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.statusCode).to.equal(409);
    expect(rejected.reason.message).to.match(/A shift is already open for this store/);
    expect(db.shifts).to.have.length(1);
    expect(db.committed).to.equal(1);
    expect(db.rolledBack).to.equal(1);
  });

  it('shows the race is real when the lock is missing', async () => {
    const {controller, db} = buildDatabase({useLock: false});

    await Promise.allSettled([
      controller.open(staff('Asha'), body()),
      controller.open(staff('Ravi'), body()),
    ]);

    expect(db.shifts).to.have.length(2);
  });

  it('lets several simultaneous openings produce exactly one open shift', async () => {
    const {controller, db} = buildDatabase();
    await Promise.allSettled(['A', 'B', 'C', 'D', 'E'].map(name => controller.open(staff(name), body())));

    expect(db.shifts).to.have.length(1);
    expect(db.rolledBack).to.equal(4);
  });

  it('locks per store, so different stores can open at the same time', async () => {
    const {controller, db} = buildDatabase({storeOf: user => `store-${user.name}`});

    const results = await Promise.all([
      controller.open(staff('1'), body()),
      controller.open(staff('2'), body()),
    ]);

    expect(results).to.have.length(2);
    expect(db.shifts.map(s => s.storeId).sort()).to.eql(['store-1', 'store-2']);
    expect([...db.lockKeys].sort()).to.eql(['shift-open:store-1', 'shift-open:store-2']);
  });

  it('allows a new opening after the earlier request finishes, with the next number', async () => {
    const {controller, db} = buildDatabase();
    await controller.open(staff('Asha'), body());
    db.shifts[0].status = ShiftStatus.CLOSED;

    const second = (await controller.open(staff('Ravi'), body())) as {message: string};

    expect(second.message).to.equal('Shift 2 opened.');
    expect(db.shifts).to.have.length(2);
  });

  it('keeps the existing error when a shift is already open', async () => {
    const {controller, db} = buildDatabase();
    db.shifts.push({storeId: 'store-1', status: ShiftStatus.OPEN, userName: 'Asha'});

    await expect(controller.open(staff('Ravi'), body())).to.be.rejectedWith(
      'A shift is already open for this store (opened by Asha). Only they can close it before a new one can be opened.',
    );
    expect(db.rolledBack).to.equal(1);
  });

  it('records a petty cash top-up with the shift, in the same transaction', async () => {
    const {controller, db} = buildDatabase();
    await controller.open(staff('Asha'), body(150));

    expect(db.petty).to.have.length(1);
    expect(db.petty[0].amount).to.equal(50);
    expect(db.shifts).to.have.length(1);
    for (const options of db.queryOptions) expect(options?.transaction).to.be.ok();
  });

  it('opens no shift if the petty cash top-up fails', async () => {
    const {controller, db} = buildDatabase({pettyFails: true});

    await expect(controller.open(staff('Asha'), body(150))).to.be.rejectedWith('petty cash write failed');

    expect(db.shifts).to.have.length(0);
    expect(db.rolledBack).to.equal(1);
    expect(db.committed).to.equal(0);
  });

  it('checks remarks before starting a transaction', async () => {
    const {controller, db} = buildDatabase();
    await expect(controller.open(staff('Asha'), {...body(), remarks: ' '})).to.be.rejectedWith(/Remarks are required/);
    expect(db.lockKeys).to.have.length(0);
  });
});
