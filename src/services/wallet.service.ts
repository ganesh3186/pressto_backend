import {pageBounds} from '../utils/sql-page';
import {literalContains} from '../utils/search-pattern';
import {BindingScope, inject, injectable} from '@loopback/core';
import {IsolationLevel, repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {PresstoDataSource} from '../datasources';
import {PaymentMode, PaymentRequestStatus, ReferenceType, WalletTransaction, WalletTransactionType} from '../models';
import {ADMIN_WALLET_RECHARGE_MODES} from '../models/payment-mode.enum';
import {WalletRechargeRequest} from '../models/wallet-recharge-request.model';
import {
  CustomerPhoneRepository,
  CustomerRepository,
  OrderRepository,
  UsersRepository,
  WalletRechargeRequestRepository,
  WalletRepository,
  WalletTransactionRepository,
} from '../repositories';
import {dispatchWhatsApp, WhatsAppService} from './whatsapp.service';

export type WalletTransactionRow = {
  id: string;
  date: Date | null;
  transactionType: 'credit' | 'debit';
  amount: number;
  customerId: string;
  customerName: string;
  customerMobile: string;
  storeId: string | null;
  shiftId: string | null;
  reference: string;
  remarks: string;
  performedBy: string | null;
};

export function roundWalletRechargeAmount(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpErrors.BadRequest('Recharge amount must be greater than zero.');
  }
  const wholeRupees = Math.floor(amount);
  const roundedAmount = wholeRupees + (amount > wholeRupees + 0.55 ? 1 : 0);
  if (roundedAmount === 0) {
    throw new HttpErrors.BadRequest('Recharge amount must round to at least one rupee.');
  }
  return roundedAmount;
}

@injectable({scope: BindingScope.TRANSIENT})
export class WalletService {
  constructor(
    @repository(WalletRepository) private walletRepository: WalletRepository,
    @repository(WalletTransactionRepository) private walletTransactionRepository: WalletTransactionRepository,
    @repository(WalletRechargeRequestRepository) private rechargeRequestRepository: WalletRechargeRequestRepository,
    @repository(CustomerRepository) private customerRepository: CustomerRepository,
    @repository(UsersRepository) private usersRepository: UsersRepository,
    @repository(CustomerPhoneRepository) private customerPhoneRepository: CustomerPhoneRepository,
    @repository(OrderRepository) private orderRepository: OrderRepository,
    @inject('services.whatsapp') private whatsAppService: WhatsAppService,
    @inject('datasources.pressto') private dataSource: PresstoDataSource,
  ) {}

  async createWallet(customerId: string, options?: object): Promise<any> {
    return this.walletRepository.create({customerId, currentBalance: 0}, options);
  }

  async credit(walletId: string, amount: number, referenceType: ReferenceType, referenceId?: string, remarks?: string, options?: object): Promise<any> {
    return this.recordEntry(walletId, WalletTransactionType.CREDIT, amount, referenceType, referenceId, remarks, options);
  }

  async debit(walletId: string, amount: number, referenceType: ReferenceType, referenceId?: string, remarks?: string, options?: object): Promise<any> {
    return this.recordEntry(walletId, WalletTransactionType.DEBIT, amount, referenceType, referenceId, remarks, options);
  }

  // Changes the balance and writes its ledger row together, so neither can
  // exist without the other. Joins the caller's transaction if there is one.
  private async recordEntry(
    walletId: string,
    transactionType: WalletTransactionType,
    amount: number,
    referenceType: ReferenceType,
    referenceId?: string,
    remarks?: string,
    options?: object,
  ): Promise<WalletTransaction> {
    const ownTransaction = (options as {transaction?: unknown} | undefined)?.transaction
      ? undefined
      : await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    const entryOptions = ownTransaction ? {...options, transaction: ownTransaction} : options;
    try {
      const delta = transactionType === WalletTransactionType.CREDIT ? Number(amount) : -Number(amount);
      const balance = await this.walletRepository.adjustBalance(walletId, delta, entryOptions);
      if (balance === null) {
        // Throws the usual not-found error if the wallet is what's missing.
        await this.walletRepository.findById(walletId, undefined, entryOptions);
        throw new HttpErrors.BadRequest('Insufficient wallet balance.');
      }
      const entry = await this.walletTransactionRepository.create({
        walletId,
        transactionType,
        amount,
        referenceType,
        referenceId,
        remarks,
        transactionDate: new Date(),
      }, entryOptions);
      await ownTransaction?.commit();
      return entry;
    } catch (error) {
      await ownTransaction?.rollback();
      throw error;
    }
  }

  // ─── Recharge flow ────────────────────────────────────────────────────────

  async initiateRecharge(
    customerId: string,
    amount: number,
    paymentMode: PaymentMode,
    remarks?: string,
    storeId?: string,
    shiftId?: string,
  ): Promise<WalletRechargeRequest> {
    if (amount <= 0) {
      throw new HttpErrors.BadRequest('Recharge amount must be greater than zero.');
    }

    const wallet = await this.walletRepository.findOne({where: {customerId}});
    if (!wallet) {
      throw new HttpErrors.NotFound('Wallet not found for this customer.');
    }

    const count = await this.rechargeRequestRepository.count({customerId});
    const requestNumber = `WR${String(count.count + 1).padStart(6, '0')}`;
    const {v4} = await import('uuid');

    return this.rechargeRequestRepository.create({
      id: v4(),
      customerId,
      walletId: wallet.id,
      requestNumber,
      amount,
      paymentMode,
      status: PaymentRequestStatus.PENDING,
      remarks,
      storeId,
      shiftId,
    });
  }

  async confirmRecharge(
    rechargeRequestId: string,
    customerId: string,
    paymentReferenceId?: string,
    gatewayResponse?: string,
  ): Promise<{rechargeRequest: WalletRechargeRequest; walletBalance: number}> {
    const request = await this.rechargeRequestRepository.findById(rechargeRequestId);

    if (request.customerId !== customerId) {
      throw new HttpErrors.Forbidden('Access denied.');
    }
    if (request.status !== PaymentRequestStatus.PENDING) {
      throw new HttpErrors.BadRequest(`Recharge request is already ${request.status}.`);
    }

    // Claim the request and credit it together: only one of two simultaneous
    // confirmations can move it off PENDING, so a recharge can't credit twice,
    // and a failed credit leaves it PENDING rather than paid with no money.
    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    let transaction: WalletTransaction;
    try {
      const claimed = await this.rechargeRequestRepository.updateAll(
        {status: PaymentRequestStatus.SUCCESS, paymentReferenceId, gatewayResponse},
        {id: rechargeRequestId, status: PaymentRequestStatus.PENDING},
        {transaction: tx},
      );
      if (claimed.count !== 1) {
        throw new HttpErrors.BadRequest('Recharge request has already been processed.');
      }
      transaction = await this.credit(
        request.walletId,
        request.amount,
        ReferenceType.MANUAL,
        rechargeRequestId,
        `Wallet recharge - ${request.requestNumber}`,
        {transaction: tx},
      );
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }

    const wallet = await this.walletRepository.findById(request.walletId);
    const updatedRequest = await this.rechargeRequestRepository.findById(rechargeRequestId);

    dispatchWhatsApp(() => this.whatsAppService.notifyWalletRecharge({
      transactionId: transaction.id,
      customerId,
      amount: Number(request.amount),
      balance: Number(wallet.currentBalance),
      date: transaction.transactionDate,
    }));

    return {rechargeRequest: updatedRequest, walletBalance: wallet.currentBalance!};
  }

  async cancelRecharge(rechargeRequestId: string, customerId: string): Promise<void> {
    const request = await this.rechargeRequestRepository.findById(rechargeRequestId);

    if (request.customerId !== customerId) {
      throw new HttpErrors.Forbidden('Access denied.');
    }
    if (request.status !== PaymentRequestStatus.PENDING) {
      throw new HttpErrors.BadRequest(`Cannot cancel a recharge request that is already ${request.status}.`);
    }

    await this.rechargeRequestRepository.updateById(rechargeRequestId, {
      status: PaymentRequestStatus.CANCELLED,
    });
  }

  async getRechargeHistory(customerId: string, limit = 20, skip = 0): Promise<WalletRechargeRequest[]> {
    return this.rechargeRequestRepository.find({
      where: {customerId},
      order: ['createdAt DESC'],
      limit,
      skip,
    });
  }

  // Returns the full transaction ledger (credits + debits) with current balance.
  // This is the source of truth for what to show in the wallet tab.
  async getWalletHistory(customerId: string, limit = 50, skip = 0): Promise<{balance: number; transactions: object[]}> {
    const wallet = await this.walletRepository.findOne({where: {customerId}});
    if (!wallet) {
      return {balance: 0, transactions: []};
    }

    const transactions = await this.walletTransactionRepository.find({
      where: {walletId: wallet.id, isDeleted: false} as any,
      order: ['transactionDate DESC'],
      limit,
      skip,
    });

    const rechargeIds = transactions
      .filter(transaction => transaction.referenceType === ReferenceType.MANUAL &&
        transaction.transactionType === WalletTransactionType.CREDIT && transaction.referenceId)
      .map(transaction => transaction.referenceId!);
    const recharges = rechargeIds.length
      ? await this.rechargeRequestRepository.find({
          where: {id: {inq: rechargeIds}, customerId},
          fields: {id: true, paymentMode: true, performedBy: true},
        })
      : [];
    const performerIds = [...new Set(recharges.filter(recharge => recharge.performedBy)
      .map(recharge => recharge.performedBy!))];
    const performers = performerIds.length
      ? await this.usersRepository.find({
          where: {id: {inq: performerIds}},
          fields: {id: true, fullName: true, username: true},
        })
      : [];
    const rechargeById = new Map(recharges.map(recharge => [recharge.id, recharge]));
    const performerNameById = new Map(performers.map(user => [
      user.id, user.fullName?.trim() ? user.fullName : user.username,
    ]));

    return {
      balance: Number(wallet.currentBalance ?? 0),
      transactions: transactions.map(transaction => {
        const recharge = rechargeById.get(transaction.referenceId ?? '');
        return {
          ...transaction.toJSON(),
          paymentMode: recharge?.paymentMode,
          performedByName: performerNameById.get(recharge?.performedBy ?? ''),
        };
      }),
    };
  }

  // Admin directly credits — no pending phase since payment is already collected in-store
  async adminRecharge(
    customerId: string,
    amount: number,
    paymentMode: PaymentMode,
    performedBy: string,
    remarks?: string,
    storeId?: string,
    shiftId?: string,
  ): Promise<{rechargeRequest: WalletRechargeRequest; walletBalance: number}> {
    const roundedAmount = roundWalletRechargeAmount(amount);
    if (!ADMIN_WALLET_RECHARGE_MODES.includes(paymentMode)) {
      throw new HttpErrors.BadRequest('Unsupported wallet recharge payment mode.');
    }

    const wallet = await this.walletRepository.findOne({where: {customerId}});
    if (!wallet) {
      throw new HttpErrors.NotFound('Wallet not found for this customer.');
    }

    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    const options = {transaction: tx};
    try {
    await this.dataSource.execute('SELECT id FROM public.wallet WHERE id = $1 FOR UPDATE', [wallet.id], options);
    const count = await this.rechargeRequestRepository.count({customerId}, options);
    const requestNumber = `WR${String(count.count + 1).padStart(6, '0')}`;
    const {v4} = await import('uuid');

    const rechargeRequest = await this.rechargeRequestRepository.create({
      id: v4(),
      customerId,
      walletId: wallet.id,
      requestNumber,
      amount: roundedAmount,
      paymentMode,
      status: PaymentRequestStatus.SUCCESS,
      performedBy,
      remarks,
      storeId,
      shiftId,
    }, options);

    const transaction = await this.credit(
      wallet.id,
      roundedAmount,
      ReferenceType.MANUAL,
      rechargeRequest.id,
      `Admin wallet recharge - ${requestNumber}`,
      options,
    );

    const updatedWallet = await this.walletRepository.findById(wallet.id, undefined, options);
    await tx.commit();
    dispatchWhatsApp(() => this.whatsAppService.notifyWalletRecharge({
      transactionId: transaction.id,
      customerId,
      amount: roundedAmount,
      balance: Number(updatedWallet.currentBalance),
      date: transaction.transactionDate,
    }));
    return {rechargeRequest, walletBalance: updatedWallet.currentBalance!};    } catch (error) { await tx.rollback(); throw error; }
  }

  // Admin manually removes money from a wallet — the correction counterpart
  // to adminRecharge above, for when an incorrect amount was credited.
  // Reuses this.debit() (already existed but was never called from any
  // controller), which itself rejects a debit larger than the current
  // balance. No WalletRechargeRequest row — that model is credit/recharge-
  // specific (carries paymentMode); the WalletTransaction row debit()
  // already creates is the full audit record for this action.
  async adminDebit(
    customerId: string,
    amount: number,
    performedByLabel: string,
    remarks: string,
  ): Promise<{walletBalance: number}> {
    if (amount <= 0) {
      throw new HttpErrors.BadRequest('Debit amount must be greater than zero.');
    }
    if (!remarks?.trim()) {
      throw new HttpErrors.BadRequest('A reason is required to debit a wallet.');
    }

    const wallet = await this.walletRepository.findOne({where: {customerId}});
    if (!wallet) {
      throw new HttpErrors.NotFound('Wallet not found for this customer.');
    }

    // WalletTransaction has no performedBy column of its own (unlike
    // WalletRechargeRequest) — fold it into remarks so the audit trail still
    // names who made the correction. performedByLabel must already be a
    // human-readable name/email (resolved by the caller) — never the raw
    // user id, since this string is shown as-is in the admin wallet ledger.
    await this.debit(
      wallet.id,
      amount,
      ReferenceType.MANUAL,
      undefined,
      `Admin wallet debit by ${performedByLabel} - ${remarks.trim()}`,
    );

    const updatedWallet = await this.walletRepository.findById(wallet.id);
    return {walletBalance: updatedWallet.currentBalance!};
  }

  // ─── Transactions ledger (admin Wallet > Transactions page) ───────────────
  // Merges two distinct sources into one feed:
  //   credit → WalletRechargeRequest (status SUCCESS) — the recharge itself,
  //            not the WalletTransaction credit it creates, since only the
  //            request carries paymentMode/storeId/shiftId.
  //   debit  → WalletTransaction where referenceType=ORDER — a wallet
  //            redemption against a ticket; store/shift come from the Order.
  // Manual admin debit corrections (ReferenceType.MANUAL debits) are
  // deliberately excluded — by design, not shown on this page.
  // No store/cluster/region scoping: every caller with wallet_transactions:read
  // sees every transaction, same posture as the Customer list already has.
  async getAllTransactions(filters: {
    customerName?: string;
    mobile?: string;
    status?: 'credit' | 'debit';
    limit?: number;
    skip?: number;
  }): Promise<{rows: WalletTransactionRow[]; total: number}> {
    const {limit, skip} = pageBounds(filters.limit ?? 50, filters.skip);
    const name = filters.customerName?.trim() ?? '';
    const digits = filters.mobile?.replace(/\D/g, '') ?? '';
    const hasFilter = Boolean(name || digits);
    const rows = await this.dataSource.execute(`WITH matching_customer AS (
      SELECT c.id FROM public.customer c WHERE c.isdeleted = false AND (
        ($1 <> '' AND (c.firstname ILIKE $1 OR c.lastname ILIKE $1))
        OR (length($2) >= 3 AND (EXISTS (SELECT 1 FROM public.users u WHERE u.id::text = c.userid AND position($2 in u.phone) > 0)
          OR EXISTS (SELECT 1 FROM public.customer_phone p WHERE p.customerid = c.id::text AND p.isdeleted = false AND position($2 in p.phone) > 0))))
    ), ledger AS NOT MATERIALIZED (
      SELECT 'recharge:' || r.id::text AS id, r.createdat AS date, 'credit' AS type,
        r.amount, r.customerid::text AS customerid, r.storeid, r.shiftid, r.requestnumber AS reference,
        r.remarks, r.performedby FROM public.wallet_recharge_request r
      WHERE r.status = 'success' AND $4 <> 'debit'
        AND (NOT $3 OR r.customerid IN (SELECT id FROM matching_customer))
      UNION ALL
      SELECT 'txn:' || t.id::text, t.transactiondate, 'debit', t.amount, w.customerid,
        o.storeid, o.shiftid, COALESCE(o.ordernumber,t.referenceid::text,''), t.remarks, null::uuid
      FROM public.wallet_transaction t JOIN public.wallet w ON w.id::text = t.walletid
      LEFT JOIN public.orders o ON o.id = t.referenceid
      WHERE t.transactiontype = 'debit' AND t.referencetype = 'order' AND t.isdeleted = false AND $4 <> 'credit'
        AND (NOT $3 OR w.customerid IN (SELECT id::text FROM matching_customer))
    ) SELECT (SELECT count(*) FROM ledger) AS total,
      COALESCE((SELECT jsonb_agg(page) FROM (SELECT * FROM ledger ORDER BY date DESC, id DESC LIMIT $5 OFFSET $6) page), '[]'::jsonb) AS rows`,
      [name ? literalContains(name) : '', digits, hasFilter, filters.status ?? '', limit, skip]);
    const page: {id: string; date: string | null; type: 'credit' | 'debit'; amount: number;
      customerid: string; storeid: string | null; shiftid: string | null;
      reference: string | null; remarks: string | null; performedby: string | null}[] = rows[0]?.rows ?? [];
    const customers = await this.loadCustomerDisplayInfo([...new Set<string>(page.map((r: {customerid: string}) => r.customerid))]);
    return {total: Number(rows[0]?.total ?? 0), rows: page.map(row => ({
      id: row.id, date: row.date ? new Date(row.date) : null, transactionType: row.type, amount: Number(row.amount), customerId: row.customerid,
      customerName: customers.get(row.customerid)?.name ?? '—', customerMobile: customers.get(row.customerid)?.mobile ?? '—',
      storeId: row.storeid, shiftId: row.shiftid, reference: row.reference ?? '', remarks: row.remarks ?? '', performedBy: row.performedby,
    }))};
  }

  private async loadCustomerDisplayInfo(
    customerIds: string[],
  ): Promise<Map<string, {name: string; mobile: string}>> {
    if (!customerIds.length) return new Map();

    const customers = await this.customerRepository.find({
      where: {id: {inq: customerIds}} as object,
      fields: {id: true, firstName: true, lastName: true, userId: true} as object,
    });
    const userIds = [...new Set(customers.map(c => String(c.userId)).filter(Boolean))];
    const users = userIds.length
      ? await this.usersRepository.find({
          where: {id: {inq: userIds}} as object,
          fields: {id: true, phone: true} as object,
        })
      : [];
    const phoneByUserId = new Map(users.map(u => [String(u.id), u.phone ?? '']));

    return new Map(
      customers.map(c => [
        String(c.id),
        {
          name: [c.firstName, c.lastName].filter(Boolean).join(' ') || '—',
          mobile: phoneByUserId.get(String(c.userId)) || '—',
        },
      ]),
    );
  }
}
