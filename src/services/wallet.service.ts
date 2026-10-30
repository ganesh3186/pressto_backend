import {BindingScope, inject, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {PaymentMode, PaymentRequestStatus, ReferenceType, WalletTransactionType} from '../models';
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
  ) {}

  async createWallet(customerId: string, options?: object): Promise<any> {
    return this.walletRepository.create({customerId, currentBalance: 0}, options);
  }

  async credit(walletId: string, amount: number, referenceType: ReferenceType, referenceId?: string, remarks?: string, options?: object): Promise<any> {
    const wallet = await this.walletRepository.findById(walletId, undefined, options);
    const newBalance = Number(wallet.currentBalance) + Number(amount);
    await this.walletRepository.updateById(walletId, {currentBalance: newBalance}, options);
    return this.walletTransactionRepository.create({
      walletId,
      transactionType: WalletTransactionType.CREDIT,
      amount,
      referenceType,
      referenceId,
      remarks,
      transactionDate: new Date(),
    }, options);
  }

  async debit(walletId: string, amount: number, referenceType: ReferenceType, referenceId?: string, remarks?: string, options?: object): Promise<any> {
    const wallet = await this.walletRepository.findById(walletId, undefined, options);
    if (Number(wallet.currentBalance) < Number(amount)) {
      throw new HttpErrors.BadRequest('Insufficient wallet balance.');
    }
    const newBalance = Number(wallet.currentBalance) - Number(amount);
    await this.walletRepository.updateById(walletId, {currentBalance: newBalance}, options);
    return this.walletTransactionRepository.create({
      walletId,
      transactionType: WalletTransactionType.DEBIT,
      amount,
      referenceType,
      referenceId,
      remarks,
      transactionDate: new Date(),
    }, options);
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

    await this.rechargeRequestRepository.updateById(rechargeRequestId, {
      status: PaymentRequestStatus.SUCCESS,
      paymentReferenceId,
      gatewayResponse,
    });

    const transaction = await this.credit(
      request.walletId,
      request.amount,
      ReferenceType.MANUAL,
      rechargeRequestId,
      `Wallet recharge - ${request.requestNumber}`,
    );

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

    const rechargeRequest = await this.rechargeRequestRepository.create({
      id: v4(),
      customerId,
      walletId: wallet.id,
      requestNumber,
      amount,
      paymentMode,
      status: PaymentRequestStatus.SUCCESS,
      performedBy,
      remarks,
      storeId,
      shiftId,
    });

    const transaction = await this.credit(
      wallet.id,
      amount,
      ReferenceType.MANUAL,
      rechargeRequest.id,
      `Admin wallet recharge - ${requestNumber}`,
    );

    const updatedWallet = await this.walletRepository.findById(wallet.id);
    dispatchWhatsApp(() => this.whatsAppService.notifyWalletRecharge({
      transactionId: transaction.id,
      customerId,
      amount: Number(amount),
      balance: Number(updatedWallet.currentBalance),
      date: transaction.transactionDate,
    }));
    return {rechargeRequest, walletBalance: updatedWallet.currentBalance!};
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
    const limit = filters.limit && filters.limit > 0 ? filters.limit : 50;
    const skip = filters.skip && filters.skip > 0 ? filters.skip : 0;

    const customerIdFilter = await this.resolveCustomerIdFilter(filters.customerName, filters.mobile);
    // A name/mobile filter was given but matched nobody — honest empty
    // result rather than falling through to "no filter, show everyone".
    if (customerIdFilter && customerIdFilter.length === 0) {
      return {rows: [], total: 0};
    }

    const fetchCap = skip + limit;
    const [credits, creditTotal] = filters.status === 'debit'
      ? [[], 0]
      : await this.fetchCreditRows(customerIdFilter, fetchCap);
    const [debits, debitTotal] = filters.status === 'credit'
      ? [[], 0]
      : await this.fetchDebitRows(customerIdFilter, fetchCap);

    const customerIds = [...new Set([...credits, ...debits].map(row => row.customerId))];
    const customerById = await this.loadCustomerDisplayInfo(customerIds);

    const merged = [...credits, ...debits]
      .map(row => {
        const customer = customerById.get(row.customerId);
        return {
          ...row,
          customerName: customer?.name ?? '—',
          customerMobile: customer?.mobile ?? '—',
        };
      })
      .sort((a, b) => (new Date(b.date ?? 0).getTime()) - (new Date(a.date ?? 0).getTime()));

    return {
      rows: merged.slice(skip, skip + limit),
      total: creditTotal + debitTotal,
    };
  }

  /** Resolves a name/mobile filter to a customerId allowlist, or null (no filter). */
  private async resolveCustomerIdFilter(
    customerName?: string,
    mobile?: string,
  ): Promise<string[] | null> {
    const name = customerName?.trim();
    const digits = mobile?.replace(/\D/g, '').trim();
    if (!name && !digits) return null;

    const clauses: object[] = [];
    if (name) {
      clauses.push({firstName: {ilike: `%${name}%`}}, {lastName: {ilike: `%${name}%`}});
    }
    if (digits && digits.length >= 3) {
      const [matchedUsers, matchedPhones] = await Promise.all([
        this.usersRepository.find({where: {phone: {like: `%${digits}%`}}, fields: {id: true}}),
        this.customerPhoneRepository.find({
          where: {phone: {like: `%${digits}%`}, isDeleted: false} as object,
          fields: {customerId: true} as object,
        }),
      ]);
      if (matchedUsers.length) clauses.push({userId: {inq: matchedUsers.map(u => u.id)}});
      if (matchedPhones.length) clauses.push({id: {inq: matchedPhones.map(p => p.customerId)}});
    }
    if (!clauses.length) return [];

    const customers = await this.customerRepository.find({
      where: {and: [{isDeleted: false}, {or: clauses}]} as object,
      fields: {id: true} as object,
    });
    return customers.map(c => String(c.id));
  }

  private async fetchCreditRows(
    customerIdFilter: string[] | null,
    fetchCap: number,
  ): Promise<[WalletTransactionRow[], number]> {
    const where: object = {
      status: PaymentRequestStatus.SUCCESS,
      ...(customerIdFilter ? {customerId: {inq: customerIdFilter}} : {}),
    };
    const [requests, total] = await Promise.all([
      this.rechargeRequestRepository.find({where, order: ['createdAt DESC'], limit: fetchCap}),
      this.rechargeRequestRepository.count(where),
    ]);

    const rows: WalletTransactionRow[] = requests.map(request => ({
      id: `recharge:${request.id}`,
      date: request.createdAt ?? null,
      transactionType: 'credit',
      amount: Number(request.amount) || 0,
      customerId: String(request.customerId),
      customerName: '',
      customerMobile: '',
      storeId: request.storeId ?? null,
      shiftId: request.shiftId ?? null,
      reference: request.requestNumber,
      remarks: request.remarks ?? '',
      performedBy: request.performedBy ?? null,
    }));
    return [rows, total.count];
  }

  private async fetchDebitRows(
    customerIdFilter: string[] | null,
    fetchCap: number,
  ): Promise<[WalletTransactionRow[], number]> {
    let walletIdFilter: string[] | undefined;
    if (customerIdFilter) {
      const wallets = await this.walletRepository.find({
        where: {customerId: {inq: customerIdFilter}} as object,
        fields: {id: true, customerId: true} as object,
      });
      walletIdFilter = wallets.map(w => String(w.id));
      if (!walletIdFilter.length) return [[], 0];
    }

    const where: object = {
      transactionType: WalletTransactionType.DEBIT,
      referenceType: ReferenceType.ORDER,
      isDeleted: false,
      ...(walletIdFilter ? {walletId: {inq: walletIdFilter}} : {}),
    };
    const [transactions, total] = await Promise.all([
      this.walletTransactionRepository.find({where, order: ['transactionDate DESC'], limit: fetchCap}),
      this.walletTransactionRepository.count(where),
    ]);
    if (!transactions.length) return [[], total.count];

    const walletIds = [...new Set(transactions.map(t => String(t.walletId)))];
    const wallets = await this.walletRepository.find({
      where: {id: {inq: walletIds}} as object,
      fields: {id: true, customerId: true} as object,
    });
    const customerIdByWalletId = new Map(wallets.map(w => [String(w.id), String(w.customerId)]));

    const orderIds = [...new Set(transactions.map(t => t.referenceId).filter(Boolean))] as string[];
    const orders = orderIds.length
      ? await this.orderRepository.find({
          where: {id: {inq: orderIds}} as object,
          fields: {id: true, orderNumber: true, storeId: true, shiftId: true} as object,
        })
      : [];
    const orderById = new Map(orders.map(o => [String(o.id), o]));

    const rows: WalletTransactionRow[] = transactions.map(txn => {
      const order = txn.referenceId ? orderById.get(String(txn.referenceId)) : undefined;
      return {
        id: `txn:${txn.id}`,
        date: txn.transactionDate ?? null,
        transactionType: 'debit',
        amount: Number(txn.amount) || 0,
        customerId: customerIdByWalletId.get(String(txn.walletId)) ?? '',
        customerName: '',
        customerMobile: '',
        storeId: order?.storeId ?? null,
        shiftId: order?.shiftId ?? null,
        reference: order?.orderNumber ?? '—',
        remarks: txn.remarks ?? '',
        performedBy: null,
      };
    });
    return [rows, total.count];
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
