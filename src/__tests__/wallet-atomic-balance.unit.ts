import {expect} from '@loopback/testlab';
import {ReferenceType} from '../models';
import {WalletRepository} from '../repositories';
import {WalletService} from '../services/wallet.service';

describe('wallet balance changes', () => {
  describe('adjustBalance', () => {
    function repositoryReturning(result: object) {
      const calls: {sql: string; params: unknown[]; options: unknown}[] = [];
      const repo = Object.assign(Object.create(WalletRepository.prototype), {
        execute: async (sql: string, params: unknown[], options: unknown) => {
          calls.push({sql, params, options});
          return result;
        },
      }) as WalletRepository;
      return {repo, calls};
    }

    it('changes the balance in one statement inside the caller transaction', async () => {
      const {repo, calls} = repositoryReturning({rows: [{currentbalance: '150.50'}]});
      const options = {transaction: {}};

      expect(await repo.adjustBalance('wallet-1', -49.5, options)).to.equal(150.5);

      expect(calls).to.have.length(1);
      expect(calls[0].params).to.eql([-49.5, 'wallet-1']);
      expect(calls[0].options).to.equal(options);
      expect(calls[0].sql).to.match(/SET currentbalance = ROUND\(COALESCE\(currentbalance, 0\) \+ \$1::numeric, 2\)/);
    });

    it('refuses an overdraft in the same statement but lets credits through', async () => {
      const {repo, calls} = repositoryReturning({rows: [{currentbalance: '1'}]});
      await repo.adjustBalance('wallet-1', 1);
      expect(calls[0].sql).to.match(/\$1::numeric >= 0 OR COALESCE\(currentbalance, 0\) \+ \$1::numeric >= 0/);
    });

    it('returns null when no row was changed', async () => {
      const {repo} = repositoryReturning({rows: [], count: 0});
      expect(await repo.adjustBalance('wallet-1', -500)).to.be.null();
    });

    it('returns the balance when it reaches exactly zero', async () => {
      const {repo} = repositoryReturning({rows: [{currentbalance: '0.00'}]});
      expect(await repo.adjustBalance('wallet-1', -500)).to.equal(0);
    });
  });

  describe('credit and debit', () => {
    function buildService(options: {balance?: number | null; ledgerFails?: boolean; walletMissing?: boolean} = {}) {
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
      const service = Object.assign(Object.create(WalletService.prototype), {
        dataSource: {
          beginTransaction: async () => {
            state.began++;
            return ownTransaction;
          },
        },
        walletRepository: {
          adjustBalance: async (_id: string, delta: number, opts: {transaction?: unknown} | undefined) => {
            state.adjustments.push({delta, options: opts});
            return options.balance === undefined ? 100 : options.balance;
          },
          findById: async () => {
            if (options.walletMissing) throw new Error('Wallet not found');
            return {id: 'wallet-1', currentBalance: 10};
          },
        },
        walletTransactionRepository: {
          create: async (entry: Record<string, unknown>, opts: {transaction?: unknown} | undefined) => {
            if (options.ledgerFails) throw new Error('ledger write failed');
            state.ledger.push({entry, options: opts});
            return {id: 'entry-1', ...entry};
          },
        },
      }) as WalletService;
      return {service, state, ownTransaction};
    }

    it('credits and writes the ledger in one committed transaction', async () => {
      const {service, state, ownTransaction} = buildService();
      await service.credit('wallet-1', 50, ReferenceType.MANUAL, 'ref-1', 'Top up');

      expect(state.adjustments[0].delta).to.equal(50);
      expect(state.adjustments[0].options?.transaction).to.equal(ownTransaction);
      expect(state.ledger[0].options?.transaction).to.equal(ownTransaction);
      expect(state.ledger[0].entry).to.containEql({transactionType: 'credit', amount: 50, referenceId: 'ref-1'});
      expect(state.committed).to.equal(1);
      expect(state.rolledBack).to.equal(0);
    });

    it('debits with a negative change', async () => {
      const {service, state} = buildService();
      await service.debit('wallet-1', 50, ReferenceType.MANUAL);

      expect(state.adjustments[0].delta).to.equal(-50);
      expect(state.ledger[0].entry).to.containEql({transactionType: 'debit', amount: 50});
    });

    it('refuses an overdraft with the existing error and writes no ledger row', async () => {
      const {service, state} = buildService({balance: null});
      await expect(service.debit('wallet-1', 500, ReferenceType.MANUAL)).to.be.rejectedWith('Insufficient wallet balance.');

      expect(state.ledger).to.have.length(0);
      expect(state.rolledBack).to.equal(1);
      expect(state.committed).to.equal(0);
    });

    it('reports a missing wallet as not found, not as insufficient balance', async () => {
      const {service, state} = buildService({balance: null, walletMissing: true});
      await expect(service.credit('missing', 5, ReferenceType.MANUAL)).to.be.rejectedWith('Wallet not found');
      expect(state.rolledBack).to.equal(1);
    });

    it('undoes the balance change when the ledger write fails', async () => {
      const {service, state} = buildService({ledgerFails: true});
      await expect(service.credit('wallet-1', 5, ReferenceType.MANUAL)).to.be.rejectedWith('ledger write failed');

      expect(state.rolledBack).to.equal(1);
      expect(state.committed).to.equal(0);
    });

    it('joins the caller transaction and leaves committing to the caller', async () => {
      const {service, state} = buildService();
      const callerTransaction = {};
      await service.credit('wallet-1', 5, ReferenceType.MANUAL, undefined, undefined, {transaction: callerTransaction});

      expect(state.began).to.equal(0);
      expect(state.adjustments[0].options?.transaction).to.equal(callerTransaction);
      expect(state.ledger[0].options?.transaction).to.equal(callerTransaction);
      expect(state.committed).to.equal(0);
    });
  });

  describe('confirmRecharge', () => {
    function buildService(claimedCount: number, creditFails = false) {
      const state = {credits: [] as unknown[], committed: 0, rolledBack: 0, claimWhere: undefined as unknown};
      const service = Object.assign(Object.create(WalletService.prototype), {
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
        rechargeRequestRepository: {
          findById: async () => ({
            id: 'request-1',
            customerId: 'customer-1',
            walletId: 'wallet-1',
            amount: 500,
            requestNumber: 'WR000001',
            status: 'pending',
          }),
          updateAll: async (_data: object, where: object) => {
            state.claimWhere = where;
            return {count: claimedCount};
          },
        },
        walletRepository: {findById: async () => ({currentBalance: 500})},
        credit: async (...args: unknown[]) => {
          if (creditFails) throw new Error('credit failed');
          state.credits.push(args);
          return {id: 'entry-1', transactionDate: new Date()};
        },
        whatsAppService: {notifyWalletRecharge: async () => undefined},
      }) as WalletService;
      return {service, state};
    }

    it('credits once when this call wins the request', async () => {
      const {service, state} = buildService(1);
      await service.confirmRecharge('request-1', 'customer-1');

      expect(state.claimWhere).to.eql({id: 'request-1', status: 'pending'});
      expect(state.credits).to.have.length(1);
      expect(state.committed).to.equal(1);
    });

    it('does not credit when a simultaneous call already took the request', async () => {
      const {service, state} = buildService(0);
      await expect(service.confirmRecharge('request-1', 'customer-1')).to.be.rejectedWith(/already been processed/);

      expect(state.credits).to.have.length(0);
      expect(state.rolledBack).to.equal(1);
    });

    it('leaves the request pending when the credit fails', async () => {
      const {service, state} = buildService(1, true);
      await expect(service.confirmRecharge('request-1', 'customer-1')).to.be.rejectedWith('credit failed');

      expect(state.rolledBack).to.equal(1);
      expect(state.committed).to.equal(0);
    });
  });
});
