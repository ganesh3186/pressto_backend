import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {Shift} from '../models/shift.model';
import {ShiftStatus} from '../models/shift-status.enum';
import {PaymentMode} from '../models/payment-mode.enum';
import {PaymentRequestStatus} from '../models/payment-request-status.enum';
import {OrderStatus} from '../models/order-status.enum';
import {SalesReturnStatus} from '../models/sales-return.model';
import {
  EmployeeRepository,
  GstTaxConfigurationRepository,
  OrderItemRepository,
  OrderRepository,
  PaymentTransactionRepository,
  SalesReturnRepository,
  ShiftRepository,
  StoreRepository,
  UsersRepository,
  WalletRechargeRequestRepository,
} from '../repositories';
import {PettyCashService} from '../services/petty-cash.service';
import {StoreScopeService} from '../services/store-scope.service';

interface ReconciliationRowInput {
  actual: number;
}

interface OpeningBalancesInput {
  cashInTill: ReconciliationRowInput;
  banking: ReconciliationRowInput;
  pettyCash: ReconciliationRowInput;
  prepaidVouchers: ReconciliationRowInput;
}

const OPENING_CATEGORY_KEYS = ['cashInTill', 'banking', 'pettyCash', 'prepaidVouchers'] as const;

// Every field the closing form accepts — operator-typed, per confirmed
// scope (no auto "expected cash" computation this pass; see
// SHIFT_MANAGEMENT_API.md for why: no brand-tagging or payment-bucket
// mapping exists yet to compute these from real orders/payments).
interface ClosingFormInput {
  collections: {cash: number; card: number; cheque: number; pgLink: number; ppVoucher: number; wallet: number};
  walletCollections: {cash: number; card: number; upi: number};
  banking: {supposed: number; deposited: number; inSafe: number};
  prepaidV: {supposed: number; sentToAc: number; inSafe: number};
  pettyCash: {
    prevSupposed: number;
    recvFromFinance: number;
    used: number;
    disapprovedAmt: number;
    actualBalance: number;
    cumulativeDiff?: number;
  };
  cardPgSettlement: {actualSettlement: number; difference?: number};
  ppVoucher: {currSupVoucher: number; actualVoucher: number; cumulativeDiff?: number};
  register: {prevSupCashInTill: number; prevActCashInTill: number; cashReceived: number; reimbursement: number};
  actualCashInTill: {actual: number; cumulativeDiff?: number; currClosureBanking?: number};
  revenue: object;
  salesReturn: object;
  remarks: string;
}

export class ShiftController {
  constructor(
    @repository(ShiftRepository) private shiftRepository: ShiftRepository,
    @repository(EmployeeRepository) private employeeRepository: EmployeeRepository,
    @repository(StoreRepository) private storeRepository: StoreRepository,
    @repository(UsersRepository) private usersRepository: UsersRepository,
    @repository(OrderRepository) private orderRepository: OrderRepository,
    @repository(OrderItemRepository) private orderItemRepository: OrderItemRepository,
    @repository(SalesReturnRepository) private salesReturnRepository: SalesReturnRepository,
    @repository(GstTaxConfigurationRepository) private gstConfigRepository: GstTaxConfigurationRepository,
    @repository(PaymentTransactionRepository) private paymentTransactionRepository: PaymentTransactionRepository,
    @repository(WalletRechargeRequestRepository) private walletRechargeRequestRepository: WalletRechargeRequestRepository,
    @inject('services.store-scope') private storeScopeService: StoreScopeService,
    @inject('services.petty-cash') private pettyCashService: PettyCashService,
  ) {}

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * The caller's own (userId, storeId, storeName/Code). A role with a fixed
   * Employee.storeId is always locked to it — requestedStoreId is ignored
   * for them, so a store_exec can never claim a shift at a store they don't
   * work at. Only a store-unbound role (manager, super_admin — no Employee
   * row, or one with no storeId) falls through to requestedStoreId, which
   * is the one and only place a client-supplied store is trusted.
   */
  private async resolveCallerStore(currentUser: UserProfile, requestedStoreId?: string) {
    const userId = currentUser[securityId];
    const employee = await this.employeeRepository.findOne({
      where: {userId, isDeleted: false} as object,
    });

    const storeId = employee?.storeId ?? requestedStoreId;
    if (!storeId) {
      throw new HttpErrors.BadRequest('Select a store — your account is not linked to one.');
    }

    const store = await this.storeRepository.findOne({where: {id: storeId}});
    if (!store) throw new HttpErrors.NotFound('Store not found.');

    let userName = employee ? `${employee.firstName} ${employee.lastName}` : '';
    if (!userName) {
      const account = await this.usersRepository.findOne({where: {id: userId} as object});
      userName = account?.fullName ?? 'User';
    }

    return {userId, userName, storeId, storeCode: store.code, storeName: store.name};
  }

  /**
   * Chains the next shift's "supposed" opening values from the store's
   * last CLOSED shift (any user) — mirrors buildOpeningSupposedValues() in
   * the frontend's shift-module.js exactly. No prior closed shift at this
   * store → the same seed defaults the mock used.
   *
   * pettyCash is the one exception: a real ledger backs it now (see
   * PettyCashService), so "supposed" is the actual current balance, not a
   * number chained from a previous shift's own self-report — that can't
   * drift out of sync with reality the way chaining could. The other
   * three categories have no real ledger behind them yet, so they keep
   * chaining as before.
   */
  private async resolveSupposedOpeningValues(storeId: string) {
    const lastClosed = await this.shiftRepository.findOne({
      where: {storeId, status: ShiftStatus.CLOSED} as object,
      order: ['closedAt DESC'],
    });
    const pettyCash = await this.pettyCashService.computeBalance(storeId);
    if (!lastClosed) {
      return {cashInTill: 2000, banking: 0, pettyCash, prepaidVouchers: 0};
    }
    const closing = (lastClosed.closing ?? {}) as Record<string, {actual?: number; inSafe?: number; actualBalance?: number; actualVoucher?: number; currSupCashInTill?: number}>;
    const opening = (lastClosed.opening ?? {}) as Record<string, {actual?: number}>;
    return {
      cashInTill:
        closing.actualCashInTill?.actual ??
        closing.register?.currSupCashInTill ??
        opening.cashInTill?.actual ??
        0,
      banking: closing.banking?.inSafe ?? opening.banking?.actual ?? 0,
      pettyCash,
      prepaidVouchers:
        closing.ppVoucher?.actualVoucher ??
        (closing.prepaidV as {inSafe?: number} | undefined)?.inSafe ??
        opening.prepaidVouchers?.actual ??
        0,
    };
  }

  /**
   * Recomputes every derived/difference field server-side rather than
   * trusting client math — mirrors recalcClosingDerived() in
   * shift-module.js field-for-field. pettyCash.cumulativeDiff and
   * actualCashInTill.currClosureBanking are passed through as typed —
   * the frontend itself never defines a formula for those two (confirmed
   * dead in its own derivation logic), so this doesn't invent one.
   */
  private recalcClosingDerived(input: ClosingFormInput): object {
    const collectionsTotal =
      Number(input.collections.cash || 0) +
      Number(input.collections.card || 0) +
      Number(input.collections.cheque || 0) +
      Number(input.collections.pgLink || 0) +
      Number(input.collections.ppVoucher || 0) +
      Number(input.collections.wallet || 0);

    const walletTotal =
      Number(input.walletCollections.cash || 0) +
      Number(input.walletCollections.card || 0) +
      Number(input.walletCollections.upi || 0);

    const bankingCumulativeDiff =
      Number(input.banking.deposited || 0) + Number(input.banking.inSafe || 0) - Number(input.banking.supposed || 0);

    // used = total submitted this shift (reserved the moment it was
    // claimed, per PettyCashService.computeBalance's deduct-on-submit
    // rule) — so it's subtracted here. disapprovedAmt = reservations
    // released back this shift (a rejection, or a partial approval's
    // shortfall) — so it's added back, not subtracted. See
    // PettyCashService.computeWindowActivity's own comment for the full
    // derivation of why this specific split reconstructs the same number
    // computeBalance() would return live.
    const pettyBalance =
      Number(input.pettyCash.prevSupposed || 0) +
      Number(input.pettyCash.recvFromFinance || 0) -
      Number(input.pettyCash.used || 0) +
      Number(input.pettyCash.disapprovedAmt || 0);
    const pettyDifference = Number(input.pettyCash.actualBalance || 0) - pettyBalance;

    const ppVoucherDifference = Number(input.ppVoucher.actualVoucher || 0) - Number(input.ppVoucher.currSupVoucher || 0);

    const currSupCashInTill =
      Number(input.register.prevSupCashInTill || 0) +
      Number(input.register.cashReceived || 0) -
      Number(input.register.reimbursement || 0);

    const actualCashInTillDifference = Number(input.actualCashInTill.actual || 0) - currSupCashInTill;

    return {
      collections: {...input.collections, total: collectionsTotal},
      walletCollections: {...input.walletCollections, total: walletTotal},
      banking: {...input.banking, cumulativeDiff: bankingCumulativeDiff},
      prepaidV: input.prepaidV,
      pettyCash: {...input.pettyCash, balance: pettyBalance, difference: pettyDifference},
      cardPgSettlement: input.cardPgSettlement,
      ppVoucher: {...input.ppVoucher, difference: ppVoucherDifference},
      register: {...input.register, currSupCashInTill},
      actualCashInTill: {...input.actualCashInTill, difference: actualCashInTillDifference},
      revenue: input.revenue,
      salesReturn: input.salesReturn,
      remarks: input.remarks,
    };
  }

  // ─── Open ─────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['shift:create']})
  @post('/shifts')
  @response(200, {description: 'Shift opened'})
  async open(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['openingBalances', 'remarks'],
            properties: {
              openingBalances: {
                type: 'object',
                required: OPENING_CATEGORY_KEYS as unknown as string[],
                properties: Object.fromEntries(
                  OPENING_CATEGORY_KEYS.map(key => [
                    key,
                    {type: 'object', required: ['actual'], properties: {actual: {type: 'number'}}},
                  ]),
                ),
              },
              remarks: {type: 'string'},
              storeId: {
                type: 'string',
                format: 'uuid',
                description: 'Required only for a caller with no fixed Employee.storeId (manager, super_admin).',
              },
            },
          },
        },
      },
    })
    body: {openingBalances: OpeningBalancesInput; remarks: string; storeId?: string},
  ): Promise<object> {
    if (!body.remarks?.trim()) {
      throw new HttpErrors.BadRequest('Remarks are required to open a shift.');
    }

    const caller = await this.resolveCallerStore(currentUser, body.storeId);

    const existingOpen = await this.shiftRepository.findOne({
      where: {userId: caller.userId, storeId: caller.storeId, status: ShiftStatus.OPEN} as object,
    });
    if (existingOpen) {
      throw new HttpErrors.Conflict('A shift is already open for this user at this store.');
    }

    const supposed = await this.resolveSupposedOpeningValues(caller.storeId);
    const opening: Record<string, {supposed: number; actual: number; difference: number}> = {};
    for (const key of OPENING_CATEGORY_KEYS) {
      const supposedValue = supposed[key];
      const actual = Number(body.openingBalances?.[key]?.actual ?? supposedValue) || 0;
      opening[key] = {supposed: supposedValue, actual, difference: actual - supposedValue};
    }

    const count = await this.shiftRepository.count({storeId: caller.storeId} as object);
    const openingNo = count.count + 1;

    const {v4} = await import('uuid');
    const now = new Date();
    const shift = await this.shiftRepository.create({
      id: v4(),
      openingNo,
      storeId: caller.storeId,
      storeCode: caller.storeCode,
      storeName: caller.storeName,
      userId: caller.userId,
      userName: caller.userName,
      status: ShiftStatus.OPEN,
      openedAt: now,
      openingUserId: caller.userId,
      openingUserName: caller.userName,
      opening: {...opening, remarks: body.remarks.trim()},
    });

    return {message: `Shift ${openingNo} opened.`, shift};
  }

  // ─── Active (the caller's own open shift) ──────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['shift:read']})
  @get('/shifts/active')
  @response(200, {description: "The caller's own open shift, if any"})
  async active(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('storeId') storeId?: string,
  ): Promise<object> {
    // A store-unbound caller (manager, super_admin) with no store picked
    // yet has, by definition, no active shift to report — not an error
    // state, just "nothing to show yet".
    let caller;
    try {
      caller = await this.resolveCallerStore(currentUser, storeId);
    } catch (error) {
      if (error instanceof HttpErrors.HttpError) return {shift: null};
      throw error;
    }
    const shift = await this.shiftRepository.findOne({
      where: {userId: caller.userId, storeId: caller.storeId, status: ShiftStatus.OPEN} as object,
    });
    return {shift: shift ?? null};
  }

  // ─── List ─────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['shift:read']})
  @get('/shifts')
  @response(200, {description: 'Shifts, filtered by store/status'})
  async find(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('storeId') storeId?: string,
    @param.query.string('status') status?: ShiftStatus,
  ): Promise<object> {
    const scope = await this.storeScopeService.resolve(currentUser);
    const narrowedStoreIds = await this.storeScopeService.narrowStoreIds(scope, {storeId});

    const and: object[] = [];
    if (status) and.push({status});
    if (narrowedStoreIds) and.push({storeId: {inq: narrowedStoreIds}});

    const shifts = await this.shiftRepository.find({
      where: (and.length ? {and} : {}) as object,
      order: ['openedAt DESC'],
    });
    return {shifts};
  }

  // ─── Detail ───────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['shift:read']})
  @get('/shifts/{id}')
  @response(200, {description: 'Shift detail'})
  async findById(@param.path.string('id') id: string): Promise<Shift> {
    const shift = await this.shiftRepository.findById(id);
    if (!shift) throw new HttpErrors.NotFound('Shift not found.');
    return shift;
  }

  // ─── Collected-so-far (prefill for the closing form) ───────────────────────
  // Real counter collections during this shift's window, bucketed to match
  // the closing form's fields — a starting point the cashier can still
  // adjust, not a silent override of what they submit. Order payments are
  // scoped to this shift's store + [openedAt, now], counter-collected only
  // (a rider's cash isn't in the till until they hand it over — tracked
  // separately by Rider Cash Handover), payments only (never refunds).
  //
  // Wallet recharges (top-ups) have no store/shift field at all — only who
  // processed it and when — so they're scoped by performedBy = this
  // shift's own opener within the same window, matching the one-cashier-
  // per-shift confirmed setup.
  //
  // ppVoucher and Wallet Collections' own upi/card have no further
  // PaymentMode source beyond what's summed here and stay operator-typed.
  //
  // pettyCash is real too (see PettyCashService.computeWindowActivity) —
  // finance top-ups and resolved (approved/rejected) expenses within this
  // same [openedAt, windowEnd] window, for the closing form's
  // recvFromFinance/used/disapprovedAmt fields.
  //
  // revenue/salesReturn are real too, and are the one pair here NOT scoped
  // by the same window basis: revenue is today's NEW tickets (orders
  // created within the window at this store), while salesReturn is today's
  // RETURN activity (SalesReturn rows approved within the window,
  // regardless of which day the original order was placed) — two
  // independent views, not a subtraction of one from the other. An
  // approved sales return already permanently reduces its order's own
  // subtotal/taxAmount/totalAmount (see SalesReturnController.approve()),
  // so a same-shift return on a same-shift ticket is already netted into
  // revenue automatically; subtracting salesReturn from it again would
  // double-count. See resolveRevenue()/resolveSalesReturn() below.
  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['shift:read']})
  @get('/shifts/{id}/collected')
  @response(200, {description: 'Real collections during this shift, bucketed for the closing form'})
  async collected(@param.path.string('id') id: string): Promise<object> {
    const shift = await this.shiftRepository.findById(id);
    if (!shift) throw new HttpErrors.NotFound('Shift not found.');

    const windowEnd = shift.closedAt ?? new Date();
    const collections = {cash: 0, card: 0, cheque: 0, pgLink: 0, wallet: 0};

    const orders = await this.orderRepository.find({
      where: {storeId: shift.storeId} as object,
      fields: {id: true} as object,
    });
    const orderIds = orders.map(o => o.id);
    if (orderIds.length) {
      const transactions = await this.paymentTransactionRepository.find({
        where: {
          orderId: {inq: orderIds},
          riderId: null,
          transactionType: {neq: 'refund'},
          paymentDate: {between: [shift.openedAt, windowEnd]},
        } as object,
      });

      const bucketOf: Record<string, 'cash' | 'card' | 'cheque' | 'pgLink' | 'wallet' | null> = {
        [PaymentMode.CASH]: 'cash',
        [PaymentMode.CARD]: 'card',
        [PaymentMode.CHEQUE]: 'cheque',
        [PaymentMode.PDC]: 'cheque',
        [PaymentMode.UPI]: 'pgLink',
        [PaymentMode.NET_BANKING]: 'pgLink',
        [PaymentMode.BANK_TRANSFER]: 'pgLink',
        [PaymentMode.GATEWAY]: 'pgLink',
        [PaymentMode.WALLET]: 'wallet',
        [PaymentMode.PAY_LATER]: null,
        [PaymentMode.ON_ACCOUNT]: null,
      };
      for (const t of transactions) {
        const bucket = bucketOf[t.paymentMode];
        if (bucket) collections[bucket] += Number(t.amount) || 0;
      }
    }

    const recharges = await this.walletRechargeRequestRepository.find({
      where: {
        performedBy: shift.userId,
        status: PaymentRequestStatus.SUCCESS,
        createdAt: {between: [shift.openedAt, windowEnd]},
      } as object,
    });
    const walletCollections = {cash: 0, card: 0, upi: 0};
    const rechargeBucketOf: Record<string, 'cash' | 'card' | 'upi' | null> = {
      [PaymentMode.CASH]: 'cash',
      [PaymentMode.CARD]: 'card',
      [PaymentMode.UPI]: 'upi',
    };
    for (const r of recharges) {
      const bucket = rechargeBucketOf[r.paymentMode];
      if (bucket) walletCollections[bucket] += Number(r.amount) || 0;
    }

    // All physical cash handled this shift, from either source — the same
    // total both feeds Register's "cash received" and raises what's
    // supposed to be bankable.
    const cashReceived = collections.cash + walletCollections.cash;
    const openingBankingActual =
      Number((shift.opening as {banking?: {actual?: number}} | undefined)?.banking?.actual) || 0;
    const bankingSupposed = openingBankingActual + cashReceived;

    const pettyCash = await this.pettyCashService.computeWindowActivity(shift.storeId, shift.openedAt, windowEnd);

    const [revenue, salesReturn] = await Promise.all([
      this.resolveRevenue(shift.storeId, shift.openedAt, windowEnd),
      this.resolveSalesReturn(shift.storeId, shift.openedAt, windowEnd),
    ]);

    return {collections, walletCollections, cashReceived, bankingSupposed, pettyCash, revenue, salesReturn};
  }

  // Today's NEW tickets — orders created within this shift's window at
  // this store, summed using their CURRENT totals (already net of any
  // approved sales return, since approve() mutates the order directly).
  // Shape matches SHIFT_REVENUE_COLUMNS (one column today: 'pressto').
  private async resolveRevenue(storeId: string, from: Date, to: Date): Promise<object> {
    const orders = await this.orderRepository.find({
      where: {
        storeId,
        createdAt: {between: [from, to]},
        status: {nin: [OrderStatus.DRAFT, OrderStatus.CANCELLED]},
      } as object,
      fields: {id: true, subtotal: true, discountAmount: true, taxAmount: true, totalAmount: true} as object,
    });

    const cell = {revenue: 0, discount: 0, taxes: 0, totalSales: 0, tickets: orders.length, items: 0, services: 0};
    for (const order of orders) {
      cell.revenue += Number(order.subtotal) || 0;
      cell.discount += Number(order.discountAmount) || 0;
      cell.taxes += Number(order.taxAmount) || 0;
      cell.totalSales += Number(order.totalAmount) || 0;
    }

    if (orders.length) {
      const items = await this.orderItemRepository.find({
        where: {orderId: {inq: orders.map(o => o.id)}} as object,
        fields: {quantity: true, additionalServiceIds: true} as object,
      });
      for (const item of items) {
        const qty = Number(item.quantity) || 0;
        cell.items += qty;
        // One service-application per garment per service actually done —
        // an item with an additional service on top of its primary one
        // counts twice for that item's quantity (confirmed with the
        // client: 2 shirts sent for one Clean service = 2 services).
        cell.services += qty * (1 + (item.additionalServiceIds?.length ?? 0));
      }
    }

    return {pressto: cell};
  }

  // Today's RETURN activity — SalesReturn rows approved within this
  // shift's window, regardless of which day the original order was
  // placed. Independent of resolveRevenue() above, not subtracted from it.
  private async resolveSalesReturn(storeId: string, from: Date, to: Date): Promise<object> {
    const emptyCell = {revenue: 0, discount: 0, taxes: 0, totalSales: 0, tickets: 0, items: 0, services: 0};

    const returns = await this.salesReturnRepository.find({
      where: {
        status: SalesReturnStatus.APPROVED,
        resolvedAt: {between: [from, to]},
      } as object,
    });
    if (!returns.length) return {pressto: emptyCell};

    // SalesReturn carries no storeId of its own — resolve it via the
    // order it belongs to and filter down to this shift's store.
    const orderIds = [...new Set(returns.map(r => r.orderId))];
    const orders = await this.orderRepository.find({
      where: {id: {inq: orderIds}} as object,
      fields: {id: true, storeId: true} as object,
    });
    const storeIdByOrderId = new Map(orders.map(o => [o.id, o.storeId]));
    const matched = returns.filter(r => storeIdByOrderId.get(r.orderId) === storeId);
    if (!matched.length) return {pressto: emptyCell};

    // Same GST-unwind formula SalesReturnController.approve() already uses
    // — creditAmount is stored tax-inclusive, split back to revenue/taxes.
    const gstConfig = await this.gstConfigRepository.findOne({
      where: {isActive: true, isDeleted: false} as object,
    });
    const gstRate = gstConfig ? Number(gstConfig.cgstPercentage) + Number(gstConfig.sgstPercentage) : 0;

    const cell = {...emptyCell};
    const ticketIds = new Set<string>();
    // discount stays 0 — SalesReturn tracks no discount component at all,
    // a known data gap, not a bug (flagged in the plan for this feature).
    const quantityByOrderItemId = new Map<string, number>();
    for (const salesReturn of matched) {
      ticketIds.add(salesReturn.orderId);
      const credit = Number(salesReturn.creditAmount) || 0;
      const preTax = gstRate > 0 ? credit / (1 + gstRate / 100) : credit;
      cell.revenue += preTax;
      cell.taxes += credit - preTax;
      cell.totalSales += credit;

      for (const entry of (salesReturn.returnedItems ?? []) as Array<{orderItemId?: string; quantity?: number}>) {
        if (!entry.orderItemId) continue;
        const qty = Number(entry.quantity) || 0;
        cell.items += qty;
        quantityByOrderItemId.set(
          entry.orderItemId,
          (quantityByOrderItemId.get(entry.orderItemId) ?? 0) + qty,
        );
      }
    }
    cell.tickets = ticketIds.size;

    if (quantityByOrderItemId.size) {
      const orderItems = await this.orderItemRepository.find({
        where: {id: {inq: [...quantityByOrderItemId.keys()]}} as object,
        fields: {id: true, additionalServiceIds: true} as object,
      });
      const additionalCountById = new Map(orderItems.map(oi => [oi.id, oi.additionalServiceIds?.length ?? 0]));
      for (const [orderItemId, qty] of quantityByOrderItemId) {
        cell.services += qty * (1 + (additionalCountById.get(orderItemId) ?? 0));
      }
    }

    return {pressto: cell};
  }

  // ─── Close ────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['shift:update']})
  @post('/shifts/{id}/close')
  @response(200, {description: 'Shift closed'})
  async close(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({content: {'application/json': {schema: {type: 'object'}}}})
    body: ClosingFormInput,
  ): Promise<object> {
    const userId = currentUser[securityId];
    const shift = await this.shiftRepository.findById(id);
    if (!shift) throw new HttpErrors.NotFound('Shift not found.');
    if (shift.status !== ShiftStatus.OPEN) {
      throw new HttpErrors.BadRequest('This shift is already closed.');
    }
    if (shift.userId !== userId) {
      throw new HttpErrors.Forbidden('Only the user who opened this shift can close it.');
    }
    if (!body.remarks?.trim()) {
      throw new HttpErrors.BadRequest('Remarks are required to close a shift.');
    }

    const employee = await this.employeeRepository.findOne({where: {userId, isDeleted: false} as object});
    const closingUserName = employee ? `${employee.firstName} ${employee.lastName}` : shift.userName;

    const closing = this.recalcClosingDerived({...body, remarks: body.remarks.trim()});
    const now = new Date();

    await this.shiftRepository.updateById(id, {
      status: ShiftStatus.CLOSED,
      closedAt: now,
      closureNo: shift.openingNo,
      closingUserId: userId,
      closingUserName,
      closing,
    });

    const updated = await this.shiftRepository.findById(id);
    return {message: `Shift ${shift.openingNo} closed.`, shift: updated};
  }
}
