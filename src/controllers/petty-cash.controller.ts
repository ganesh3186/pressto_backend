import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, post, del, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {PettyCashStatus} from '../models/petty-cash-status.enum';
import {
  EmployeeRepository,
  PettyCashFinanceEntryRepository,
  PettyCashRegisterEntryRepository,
  StoreRepository,
  UsersRepository,
} from '../repositories';
import {PettyCashService} from '../services/petty-cash.service';
import {StoreScopeService} from '../services/store-scope.service';

/**
 * Petty cash — a store's small-expense float. Two independent write paths
 * feed one running balance (see PettyCashService.computeBalance):
 * Finance tops it up, staff log expenses against it (pending until a
 * manager resolves them — only an APPROVED entry actually debits it).
 * Also the backing data for Shift's opening/closing pettyCash
 * reconciliation (see shift.controller.ts).
 */
export class PettyCashController {
  constructor(
    @repository(PettyCashFinanceEntryRepository) private financeRepo: PettyCashFinanceEntryRepository,
    @repository(PettyCashRegisterEntryRepository) private registerRepo: PettyCashRegisterEntryRepository,
    @repository(StoreRepository) private storeRepo: StoreRepository,
    @repository(EmployeeRepository) private employeeRepo: EmployeeRepository,
    @repository(UsersRepository) private usersRepo: UsersRepository,
    @inject('services.petty-cash') private pettyCashService: PettyCashService,
    @inject('services.store-scope') private storeScopeService: StoreScopeService,
  ) {}

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** Display name for the caller — employee name first, else account fullName. */
  private async resolveCallerName(userId: string): Promise<string> {
    const employee = await this.employeeRepo.findOne({where: {userId, isDeleted: false} as object});
    if (employee) return `${employee.firstName} ${employee.lastName}`.trim();
    const account = await this.usersRepo.findOne({where: {id: userId} as object});
    return account?.fullName ?? 'User';
  }

  /**
   * Same posture as ShiftController.resolveCallerStore: a role with a
   * fixed Employee.storeId is always locked to it (requestedStoreId
   * ignored); only a store-unbound role falls through to the
   * client-supplied store. Petty cash register entries have the exact
   * same one-store-per-cashier semantics as a Shift.
   */
  private async resolveCallerStore(currentUser: UserProfile, requestedStoreId?: string) {
    const userId = currentUser[securityId];
    const employee = await this.employeeRepo.findOne({where: {userId, isDeleted: false} as object});
    const storeId = employee?.storeId ?? requestedStoreId;
    if (!storeId) {
      throw new HttpErrors.BadRequest('Select a store — your account is not linked to one.');
    }
    const store = await this.storeRepo.findOne({where: {id: storeId}});
    if (!store) throw new HttpErrors.NotFound('Store not found.');
    return {userId, storeId, storeCode: store.code, storeName: store.name};
  }

  private async assertStoreAccessible(currentUser: UserProfile, storeId: string) {
    const scope = await this.storeScopeService.resolve(currentUser);
    if (!this.storeScopeService.allows(scope, storeId)) {
      throw new HttpErrors.NotFound('Store not found.');
    }
  }

  // ─── Finance — top up a store's float ────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['petty_cash_finance:create']})
  @post('/petty-cash/finance-entries')
  @response(200, {description: "Finance entry added to a store's petty cash float"})
  async createFinanceEntry(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['storeId', 'amount', 'remarks'],
            properties: {
              storeId: {type: 'string', format: 'uuid'},
              amount: {type: 'number', minimum: 0.01},
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {storeId: string; amount: number; remarks: string},
  ): Promise<object> {
    if (!body.remarks?.trim()) throw new HttpErrors.BadRequest('Remarks are required.');
    await this.assertStoreAccessible(currentUser, body.storeId);
    const store = await this.storeRepo.findOne({where: {id: body.storeId}});
    if (!store) throw new HttpErrors.NotFound('Store not found.');

    const userId = currentUser[securityId];
    const {v4} = await import('uuid');
    const entry = await this.financeRepo.create({
      id: v4(),
      storeId: body.storeId,
      storeCode: store.code,
      storeName: store.name,
      amount: body.amount,
      remarks: body.remarks.trim(),
      createdBy: userId,
      createdByName: await this.resolveCallerName(userId),
      createdAt: new Date(),
    });

    const balance = await this.pettyCashService.computeBalance(body.storeId);
    return {message: 'Petty cash amount saved for store.', entry, balance};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['petty_cash:read']})
  @get('/petty-cash/finance-entries')
  @response(200, {description: "A store's finance (top-up) entries"})
  async listFinanceEntries(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('storeId') storeId: string,
  ): Promise<object> {
    if (!storeId) throw new HttpErrors.BadRequest('storeId query parameter is required.');
    await this.assertStoreAccessible(currentUser, storeId);
    const entries = await this.financeRepo.find({where: {storeId} as object, order: ['createdAt DESC']});
    return {entries};
  }

  // ─── Balance ──────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['petty_cash:read']})
  @get('/petty-cash/balance')
  @response(200, {description: "A store's current petty cash balance"})
  async getBalance(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('storeId') storeId: string,
  ): Promise<object> {
    if (!storeId) throw new HttpErrors.BadRequest('storeId query parameter is required.');
    await this.assertStoreAccessible(currentUser, storeId);
    const balance = await this.pettyCashService.computeBalance(storeId);
    return {storeId, balance};
  }

  // ─── Register — log an expense ─────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['petty_cash_register:create']})
  @post('/petty-cash/register-entries')
  @response(200, {description: 'Expense logged, pending manager approval'})
  async createRegisterEntry(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['expenseDate', 'amount', 'description', 'remarks'],
            properties: {
              storeId: {
                type: 'string',
                format: 'uuid',
                description: 'Required only for a caller with no fixed Employee.storeId (manager, super_admin).',
              },
              expenseDate: {type: 'string', format: 'date-time'},
              amount: {type: 'number', minimum: 0.01},
              method: {type: 'string'},
              description: {type: 'string'},
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {
      storeId?: string;
      expenseDate: string;
      amount: number;
      method?: string;
      description: string;
      remarks: string;
    },
  ): Promise<object> {
    if (!body.remarks?.trim()) throw new HttpErrors.BadRequest('Remarks are required.');
    if (!body.description?.trim()) throw new HttpErrors.BadRequest('Description is required.');
    if (!body.amount || body.amount <= 0) throw new HttpErrors.BadRequest('Enter a valid amount.');

    const caller = await this.resolveCallerStore(currentUser, body.storeId);

    // A submitted expense reserves its full amount immediately (see
    // PettyCashService.computeBalance) — can't claim more than the store
    // actually has available right now, including whatever's already
    // reserved by other still-pending expenses.
    const balance = await this.pettyCashService.computeBalance(caller.storeId);
    if (body.amount > balance) {
      throw new HttpErrors.BadRequest(
        `This expense (${body.amount}) exceeds the available petty cash balance (${balance}).`,
      );
    }

    const {v4} = await import('uuid');
    const entry = await this.registerRepo.create({
      id: v4(),
      storeId: caller.storeId,
      storeCode: caller.storeCode,
      storeName: caller.storeName,
      userId: caller.userId,
      userName: await this.resolveCallerName(caller.userId),
      expenseDate: new Date(body.expenseDate),
      amount: body.amount,
      method: body.method ?? 'Cash',
      description: body.description.trim(),
      remarks: body.remarks.trim(),
      status: PettyCashStatus.PENDING,
    });

    return {message: 'Expense submitted for approval.', entry};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['petty_cash:read']})
  @get('/petty-cash/register-entries')
  @response(200, {description: 'Register (expense) entries — one store, or every store the caller can see'})
  async listRegisterEntries(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('storeId') storeId?: string,
    @param.query.string('status') status?: PettyCashStatus,
  ): Promise<object> {
    const scope = await this.storeScopeService.resolve(currentUser);
    const narrowedStoreIds = await this.storeScopeService.narrowStoreIds(scope, {storeId});

    const and: object[] = [{isDeleted: false}];
    if (narrowedStoreIds) and.push({storeId: {inq: narrowedStoreIds}});
    if (status) and.push({status});

    const entries = await this.registerRepo.find({
      where: {and} as object,
      order: ['expenseDate DESC'],
    });
    return {entries};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['petty_cash_register:delete']})
  @del('/petty-cash/register-entries/{id}')
  @response(200, {description: 'Pending expense entry deleted'})
  async deleteRegisterEntry(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<object> {
    const entry = await this.registerRepo.findOne({where: {id, isDeleted: false} as object});
    if (!entry) throw new HttpErrors.NotFound('Expense entry not found.');
    await this.assertStoreAccessible(currentUser, entry.storeId);
    if (entry.status !== PettyCashStatus.PENDING) {
      throw new HttpErrors.BadRequest('Only a pending expense can be deleted — it has already been resolved.');
    }
    await this.registerRepo.updateById(id, {isDeleted: true, deletedAt: new Date()});
    return {message: 'Expense deleted.'};
  }

  // ─── Approve / Reject ───────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['petty_cash_register:update']})
  @post('/petty-cash/register-entries/{id}/resolve')
  @response(200, {description: 'Expense entry approved (fully or partially) or rejected'})
  async resolveRegisterEntry(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['approved', 'remark'],
            properties: {
              approved: {type: 'boolean'},
              approvedAmount: {
                type: 'number',
                description: 'Required when approved is true. May be less than the requested amount (partial approval).',
              },
              remark: {type: 'string'},
            },
          },
        },
      },
    })
    body: {approved: boolean; approvedAmount?: number; remark: string},
  ): Promise<object> {
    if (!body.remark?.trim()) {
      throw new HttpErrors.BadRequest('A remark is required to approve or reject an expense.');
    }
    const entry = await this.registerRepo.findOne({where: {id, isDeleted: false} as object});
    if (!entry) throw new HttpErrors.NotFound('Expense entry not found.');
    await this.assertStoreAccessible(currentUser, entry.storeId);
    if (entry.status !== PettyCashStatus.PENDING) {
      throw new HttpErrors.BadRequest('This expense has already been resolved.');
    }

    const requestedAmount = Number(entry.amount);
    let approvedAmount = 0;
    if (body.approved) {
      approvedAmount = Number(body.approvedAmount);
      if (!approvedAmount || approvedAmount <= 0 || approvedAmount > requestedAmount) {
        throw new HttpErrors.BadRequest('approvedAmount must be greater than 0 and at most the requested amount.');
      }
    }
    const disapprovedAmt = body.approved ? Math.max(0, requestedAmount - approvedAmount) : requestedAmount;

    const userId = currentUser[securityId];
    await this.registerRepo.updateById(id, {
      status: body.approved ? PettyCashStatus.APPROVED : PettyCashStatus.REJECTED,
      approvedAmount,
      disapprovedAmt,
      resolvedRemark: body.remark.trim(),
      resolvedBy: userId,
      resolvedByName: await this.resolveCallerName(userId),
      resolvedAt: new Date(),
    });

    const updated = await this.registerRepo.findById(id);
    const balance = await this.pettyCashService.computeBalance(entry.storeId);
    return {
      message: body.approved ? 'Expense approved.' : 'Expense rejected.',
      entry: updated,
      balance,
    };
  }
}
