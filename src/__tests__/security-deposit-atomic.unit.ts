import {expect} from '@loopback/testlab';
import fs from 'fs';
import path from 'path';
import {ReferenceType} from '../models';
import {CustomerSecurityDepositRepository} from '../repositories';
import {SecurityDepositService} from '../services/security-deposit.service';

describe('security deposit balance changes', () => {
  it('leaves no service writing a deposit balance directly', () => {
    // Tests run from dist/__tests__, so step back up to the TypeScript sources.
    const servicesDir = path.join(__dirname, '../../src/services');
    const offenders = fs
      .readdirSync(servicesDir)
      .filter(file => file.endsWith('.ts'))
      .filter(file => /[dD]eposit(Repo|Repository)\s*\.\s*(updateById|replaceById|updateAll)\s*\(/.test(
        fs.readFileSync(path.join(servicesDir, file), 'utf8'),
      ));
    expect(offenders).to.eql([]);
  });

  describe('adjustBalance', () => {
    function repositoryReturning(result: object) {
      const calls: {sql: string; params: unknown[]; options: unknown}[] = [];
      const repo = Object.assign(Object.create(CustomerSecurityDepositRepository.prototype), {
        execute: async (sql: string, params: unknown[], options: unknown) => {
          calls.push({sql, params, options});
          return result;
        },
      }) as CustomerSecurityDepositRepository;
      return {repo, calls};
    }

    it('changes the balance in one statement inside the caller transaction', async () => {
      const {repo, calls} = repositoryReturning({rows: [{availablebalance: '150.50'}]});
      const options = {transaction: {}};

      expect(await repo.adjustBalance('deposit-1', 50.5, options)).to.equal(150.5);

      expect(calls).to.have.length(1);
      expect(calls[0].params).to.eql([50.5, 'deposit-1']);
      expect(calls[0].options).to.equal(options);
    });

    it('raises the total deposited on a top-up but not on a deduction', async () => {
      const {repo, calls} = repositoryReturning({rows: [{availablebalance: '1'}]});
      await repo.adjustBalance('deposit-1', -1);
      expect(calls[0].sql).to.match(/depositamount = ROUND\(COALESCE\(depositamount, 0\) \+ GREATEST\(\$1::numeric, 0\), 2\)/);
    });

    it('refuses an overdraft in the same statement', async () => {
      const {repo, calls} = repositoryReturning({rows: [{availablebalance: '1'}]});
      await repo.adjustBalance('deposit-1', -1);
      expect(calls[0].sql).to.match(/\$1::numeric >= 0 OR COALESCE\(availablebalance, 0\) \+ \$1::numeric >= 0/);
    });

    it('returns null when no row was changed', async () => {
      const {repo} = repositoryReturning({rows: [], count: 0});
      expect(await repo.adjustBalance('deposit-1', -500)).to.be.null();
    });

    it('returns the balance when it reaches exactly zero', async () => {
      const {repo} = repositoryReturning({rows: [{availablebalance: '0.00'}]});
      expect(await repo.adjustBalance('deposit-1', -500)).to.equal(0);
    });
  });

  describe('addAmount and deductAmount', () => {
    function buildService(options: {balance?: number | null; ledgerFails?: boolean; depositMissing?: boolean} = {}) {
      const state = {
        began: 0,
        committed: 0,
        rolledBack: 0,
        adjustments: [] as {delta: number; options: {transaction?: unknown} | undefined}[],
        ledger: [] as {entry: Record<string, unknown>; options: {transaction?: unknown} | undefined}[],
      };
      const ownTransaction = {
        commit: async () => {
          state.committed++;
        },
        rollback: async () => {
          state.rolledBack++;
        },
      };
      const service = Object.assign(Object.create(SecurityDepositService.prototype), {
        dataSource: {
          beginTransaction: async () => {
            state.began++;
            return ownTransaction;
          },
        },
        depositRepository: {
          adjustBalance: async (_id: string, delta: number, opts: {transaction?: unknown} | undefined) => {
            state.adjustments.push({delta, options: opts});
            return options.balance === undefined ? 100 : options.balance;
          },
          findById: async () => {
            if (options.depositMissing) throw new Error('Deposit not found');
            return {id: 'deposit-1', availableBalance: 10};
          },
        },
        depositTxRepository: {
          create: async (entry: Record<string, unknown>, opts: {transaction?: unknown} | undefined) => {
            if (options.ledgerFails) throw new Error('ledger write failed');
            state.ledger.push({entry, options: opts});
            return {id: 'entry-1', ...entry};
          },
        },
      }) as SecurityDepositService;
      return {service, state, ownTransaction};
    }

    it('adds and writes the ledger in one committed transaction', async () => {
      const {service, state, ownTransaction} = buildService();
      await service.addAmount('deposit-1', 50, ReferenceType.MANUAL, 'ref-1', 'Top up');

      expect(state.adjustments[0].delta).to.equal(50);
      expect(state.adjustments[0].options?.transaction).to.equal(ownTransaction);
      expect(state.ledger[0].options?.transaction).to.equal(ownTransaction);
      expect(state.ledger[0].entry).to.containEql({
        securityDepositId: 'deposit-1',
        transactionType: 'deposit',
        amount: 50,
        referenceId: 'ref-1',
      });
      expect(state.committed).to.equal(1);
      expect(state.rolledBack).to.equal(0);
    });

    it('deducts with a negative change', async () => {
      const {service, state} = buildService();
      await service.deductAmount('deposit-1', 50, ReferenceType.MANUAL);

      expect(state.adjustments[0].delta).to.equal(-50);
      expect(state.ledger[0].entry).to.containEql({transactionType: 'deduction', amount: 50});
    });

    it('refuses an overdraft with the existing error and writes no ledger row', async () => {
      const {service, state} = buildService({balance: null});
      await expect(service.deductAmount('deposit-1', 500, ReferenceType.MANUAL))
        .to.be.rejectedWith('Insufficient security deposit balance.');

      expect(state.ledger).to.have.length(0);
      expect(state.rolledBack).to.equal(1);
      expect(state.committed).to.equal(0);
    });

    it('reports a missing deposit as not found, not as insufficient balance', async () => {
      const {service, state} = buildService({balance: null, depositMissing: true});
      await expect(service.addAmount('missing', 5, ReferenceType.MANUAL)).to.be.rejectedWith('Deposit not found');
      expect(state.rolledBack).to.equal(1);
    });

    it('undoes the balance change when the ledger write fails', async () => {
      const {service, state} = buildService({ledgerFails: true});
      await expect(service.addAmount('deposit-1', 5, ReferenceType.MANUAL)).to.be.rejectedWith('ledger write failed');

      expect(state.rolledBack).to.equal(1);
      expect(state.committed).to.equal(0);
    });

    it('joins the caller transaction and leaves committing to the caller', async () => {
      const {service, state} = buildService();
      const callerTransaction = {};
      await service.addAmount('deposit-1', 5, ReferenceType.MANUAL, undefined, undefined, {transaction: callerTransaction});

      expect(state.began).to.equal(0);
      expect(state.adjustments[0].options?.transaction).to.equal(callerTransaction);
      expect(state.ledger[0].options?.transaction).to.equal(callerTransaction);
      expect(state.committed).to.equal(0);
    });
  });

  describe('confirmTopup', () => {
    function buildService(claimedCount: number, addFails = false) {
      const state = {
        added: [] as unknown[][],
        committed: 0,
        rolledBack: 0,
        claimWhere: undefined as unknown,
      };
      const service = Object.assign(Object.create(SecurityDepositService.prototype), {
        dataSource: {
          beginTransaction: async () => ({
            commit: async () => {
              state.committed++;
            },
            rollback: async () => {
              state.rolledBack++;
            },
          }),
        },
        topupRequestRepository: {
          findById: async () => ({
            id: 'request-1',
            customerId: 'customer-1',
            securityDepositId: 'deposit-1',
            amount: 500,
            requestNumber: 'SDT000001',
            status: 'pending',
          }),
          updateAll: async (_data: object, where: object) => {
            state.claimWhere = where;
            return {count: claimedCount};
          },
        },
        depositRepository: {findById: async () => ({availableBalance: 500})},
        addAmount: async (...args: unknown[]) => {
          if (addFails) throw new Error('credit failed');
          state.added.push(args);
          return {id: 'entry-1'};
        },
      }) as SecurityDepositService;
      return {service, state};
    }

    it('credits once, in the same transaction, when this call wins the request', async () => {
      const {service, state} = buildService(1);
      const result = await service.confirmTopup('request-1', 'customer-1', 'pay_1');

      expect(state.claimWhere).to.eql({id: 'request-1', status: 'pending'});
      expect(state.added).to.have.length(1);
      expect(state.added[0][5]).to.have.property('transaction');
      expect(state.committed).to.equal(1);
      expect(result.availableBalance).to.equal(500);
    });

    it('does not credit when a simultaneous call already took the request', async () => {
      const {service, state} = buildService(0);
      await expect(service.confirmTopup('request-1', 'customer-1')).to.be.rejectedWith(/already been processed/);

      expect(state.added).to.have.length(0);
      expect(state.rolledBack).to.equal(1);
    });

    it('leaves the request pending when the credit fails', async () => {
      const {service, state} = buildService(1, true);
      await expect(service.confirmTopup('request-1', 'customer-1')).to.be.rejectedWith('credit failed');

      expect(state.rolledBack).to.equal(1);
      expect(state.committed).to.equal(0);
    });
  });
});
