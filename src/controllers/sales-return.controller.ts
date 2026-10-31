import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {Options, repository} from '@loopback/repository';
import {
  get,
  HttpErrors,
  param,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {PresstoDataSource} from '../datasources';
import {SalesReturn, SalesReturnStatus} from '../models/sales-return.model';
import {
  ORDER_STATUS_TRANSITIONS,
  OrderStatus,
} from '../models/order-status.enum';
import {GarmentStatus} from '../models/garment-status.enum';
import {Order} from '../models/order.model';
import {InvoiceStatus} from '../models/invoice.model';
import {RefundDueStatus} from '../models/refund-due-status.enum';
import {RefundMethod} from '../models/refund-method.enum';
import {ShiftStatus} from '../models/shift-status.enum';
import {RefundBankDetails} from '../models/refund-due.model';
import {
  CustomerRepository,
  GarmentRepository,
  GstTaxConfigurationRepository,
  InvoiceOrderLinkRepository,
  InvoiceRepository,
  ItemRepository,
  OrderItemRepository,
  OrderRepository,
  OrderStatusHistoryRepository,
  PaymentTransactionRepository,
  SalesReturnRepository,
  ShiftRepository,
  ChallanRepository,
  RefundDueRepository,
} from '../repositories';
import {StoreScopeService} from '../services/store-scope.service';
import {ApprovalService} from '../services/approval.service';

/** Coerce a Postgres numeric (returned as a string) to a usable 2dp number. */
function money(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** Order/invoice/challan totals are always a whole rupee. */
function roundRupee(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

interface CreditBasis {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
}
interface CreditLine {
  orderItemId: string;
  quantity: number;
  originalAmount: number;
  amount: number;
  taxAmount: number;
  grossAmount: number;
  garmentIds: string[];
  invoiceBasis: CreditBasis;
}

/** Credit follows the issued invoice's discount and tax, never its payment state. */
export function invoiceCreditValue(amount: number, basis: CreditBasis) {
  const discount =
    basis.subtotal > 0 ? money((amount * basis.discount) / basis.subtotal) : 0;
  const discounted = money(Math.max(0, amount - discount));
  const taxable = money(Math.max(0, basis.subtotal - basis.discount));
  const taxAmount = taxable > 0 ? money((discounted * basis.tax) / taxable) : 0;
  const rounding = basis.total - money(taxable + basis.tax);
  const roundingShare =
    basis.subtotal > 0 ? (rounding * amount) / basis.subtotal : 0;
  return {
    amount: discounted,
    taxAmount,
    grossAmount: money(discounted + taxAmount + roundingShare),
  };
}

/** Legacy pricing helper; new invoice credits use invoiceCreditValue. */
export function calculateSalesReturnCreditAmount(
  preTaxAmount: unknown,
  gstRate: unknown,
  orderPaid = true,
): number {
  const amount = money(preTaxAmount);
  // Paid returns refund the GST already collected. For an unpaid order no tax
  // has been collected, so only the discounted item/services/add-on subtotal
  // is credited against the outstanding order value.
  return orderPaid
    ? money(amount * (1 + (Number(gstRate) || 0) / 100))
    : amount;
}

export function calculateDiscountedSalesReturnAmount(
  itemAmount: unknown,
  orderSubtotal: unknown,
  orderDiscount: unknown,
): number {
  const amount = money(itemAmount);
  const subtotal = money(orderSubtotal);
  const discount = Math.min(money(orderDiscount), subtotal);
  if (amount <= 0 || subtotal <= 0 || discount <= 0) return amount;
  return money(Math.max(0, amount - (discount * amount) / subtotal));
}

export function previewCreditNoteRefund(
  record: SalesReturn,
  order: Order,
  payments: {transactionType?: string; amount: number}[],
  unpaidRefundDues: {amount: number}[],
) {
  const newOrderTotal = Math.max(
    0,
    roundRupee(money(order.totalAmount) - money(record.creditAmount)),
  );
  const txnCollected = payments.reduce(
    (sum, payment) =>
      sum + (payment.transactionType === 'refund' ? 0 : money(payment.amount)),
    0,
  );
  const paidRefunds = payments.reduce(
    (sum, payment) =>
      sum + (payment.transactionType === 'refund' ? money(payment.amount) : 0),
    0,
  );
  const unpaidRefundTotal = unpaidRefundDues.reduce(
    (sum, refund) => sum + money(refund.amount),
    0,
  );
  const allocated = money(
    (order as Order & {allocatedPayment?: number}).allocatedPayment,
  );
  const isChild = !!(order as Order & {parentOrderId?: string}).parentOrderId;
  const collected = isChild
    ? money(allocated + txnCollected)
    : order.hasBeenSplit
      ? allocated
      : txnCollected;
  const netPaid = money(collected - money(paidRefunds + unpaidRefundTotal));
  return {
    newOrderTotal,
    refundAmount: money(Math.max(0, netPaid - newOrderTotal)),
    newBalanceDue: money(Math.max(0, newOrderTotal - netPaid)),
  };
}

export class SalesReturnController {
  constructor(
    @repository(SalesReturnRepository)
    private salesReturnRepo: SalesReturnRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(ItemRepository) private itemRepo: ItemRepository,
    @repository(InvoiceRepository) private invoiceRepo: InvoiceRepository,
    @repository(InvoiceOrderLinkRepository)
    private invoiceOrderLinkRepo: InvoiceOrderLinkRepository,
    @repository(ChallanRepository) private challanRepo: ChallanRepository,
    @repository(OrderStatusHistoryRepository)
    private statusHistoryRepo: OrderStatusHistoryRepository,
    @repository(PaymentTransactionRepository)
    private paymentRepo: PaymentTransactionRepository,
    @repository(CustomerRepository) private customerRepo: CustomerRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @repository(GstTaxConfigurationRepository)
    private gstConfigRepo: GstTaxConfigurationRepository,
    @repository(RefundDueRepository) private refundDueRepo: RefundDueRepository,
    @inject('datasources.pressto') private dataSource: PresstoDataSource,
    @inject('services.store-scope')
    private storeScopeService: StoreScopeService,
    @inject('services.approval') private approvalService: ApprovalService,
    @repository(ShiftRepository) private shiftRepo: ShiftRepository,
  ) {}

  private async findInvoiceForOrder(orderId: string, options?: Options) {
    const direct = await this.invoiceRepo.findOne({where: {orderId}}, options);
    if (direct) return direct;
    const link = await this.invoiceOrderLinkRepo.findOne(
      {where: {orderId}},
      options,
    );
    return link
      ? this.invoiceRepo.findById(link.invoiceId, undefined, options)
      : null;
  }

  /**
   * The current GST rate (CGST + SGST %), same source order creation itself
   * uses. Used instead of deriving an "effective tax rate" back out of the
   * order's own subtotal/taxAmount — those can go stale (e.g. after an
   * Upgrade that changes the subtotal without recomputing tax), which would
   * silently carry that drift into every credit note's GST gross-up.
   */
  private async _resolveGstRate(): Promise<number> {
    const gstConfig = await this.gstConfigRepo.findOne({
      where: {isActive: true, isDeleted: false} as object,
    });
    return gstConfig
      ? Number(gstConfig.cgstPercentage) + Number(gstConfig.sgstPercentage)
      : 0;
  }

  /**
   * Preview exactly what approve() would do to the order's totals, and how
   * much (if any) money needs to leave the order beyond a balance-due
   * reduction. Shared by the global pending-list endpoint (read-only
   * preview) and approve() itself — same numbers, computed once.
   */
  private async _previewCreditNote(
    record: SalesReturn,
    order: Order,
    options?: Options,
  ): Promise<{
    newOrderTotal: number;
    refundAmount: number;
    newBalanceDue: number;
  }> {
    const payments = await this.paymentRepo.find(
      {
        where: {orderId: record.orderId},
      } as any,
      options,
    );
    const unpaidRefundDues = await this.refundDueRepo.find(
      {
        where: {
          orderId: record.orderId,
          status: {inq: [RefundDueStatus.PENDING, RefundDueStatus.REQUESTED]},
        },
      },
      options,
    );
    return previewCreditNoteRefund(record, order, payments, unpaidRefundDues);
  }

  // ─── Create Sales Return ──────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @post('/orders/{orderId}/sales-return')
  @response(200, {description: 'Sales return created'})
  async create(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('orderId') orderId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              reason: {type: 'string'},
              remarks: {type: 'string'},
              returnedItems: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    orderItemId: {type: 'string'},
                    quantity: {type: 'number'},
                    amount: {type: 'number'},
                  },
                },
              },
              // Picked up front — only ever used if this return leaves a
              // refund due; submission pays it out immediately with this.
              refundMethod: {type: 'string', enum: Object.values(RefundMethod)},
              cashShiftId: {type: 'string', format: 'uuid'},
              bankDetails: {
                type: 'object',
                properties: {
                  accountHolderName: {type: 'string'},
                  bankName: {type: 'string'},
                  accountNumber: {type: 'string'},
                  ifscCode: {type: 'string'},
                  branchName: {type: 'string'},
                },
              },
            },
          },
        },
      },
    })
    body: {
      reason?: string;
      remarks?: string;
      returnedItems?: Array<{
        orderItemId: string;
        quantity: number;
        amount: number;
      }>;
      refundMethod?: string;
      cashShiftId?: string;
      bankDetails?: RefundBankDetails;
    },
    @param.query.boolean('preview') preview = false,
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(orderId, currentUser);
    const tx = await this.dataSource.beginTransaction({
      isolationLevel: 'READ COMMITTED',
    });
    const options = {transaction: tx};
    try {
      await this.dataSource.execute(
        'SELECT id FROM public.orders WHERE id = $1 FOR UPDATE',
        [orderId],
        options,
      );
      const order = await this.orderRepo.findOne(
        {
          where: {id: orderId, isDeleted: false},
        },
        options,
      );
      if (!order) throw new HttpErrors.NotFound('Order not found.');
      if (
        ![
          OrderStatus.READY,
          OrderStatus.PARTIALLY_DISPATCHED,
          OrderStatus.OUT_FOR_DELIVERY,
          OrderStatus.DELIVERED,
          OrderStatus.RETURNED,
        ].includes(order.status!)
      ) {
        throw new HttpErrors.BadRequest(
          'Credit notes require a Ready or later ticket with a final invoice.',
        );
      }
      if (!body.reason?.trim() || !body.returnedItems?.length) {
        throw new HttpErrors.BadRequest(
          'Select at least one item and provide a credit-note reason.',
        );
      }
      const invoice = await this.findInvoiceForOrder(orderId, options);
      if (!invoice || invoice.status !== InvoiceStatus.ISSUED) {
        throw new HttpErrors.BadRequest(
          'Generate a final invoice before creating a credit note.',
        );
      }
      if (
        new Set(body.returnedItems.map(line => line.orderItemId)).size !==
          body.returnedItems.length ||
        body.returnedItems.some(
          line =>
            !line.orderItemId ||
            !Number.isSafeInteger(line.quantity) ||
            line.quantity < 1,
        )
      ) {
        throw new HttpErrors.BadRequest(
          'Return each item once with a positive whole-number quantity.',
        );
      }

      // A returned or damaged garment was already removed from ticket billing;
      // only still-billable pieces may enter a sales return.
      const requestedQtyByOrderItemId = new Map<string, number>();
      for (const line of body.returnedItems ?? []) {
        if (!line.orderItemId) continue;
        requestedQtyByOrderItemId.set(
          line.orderItemId,
          (requestedQtyByOrderItemId.get(line.orderItemId) ?? 0) +
            (Number(line.quantity) || 0),
        );
      }
      const requestedOrderItemIds = [...requestedQtyByOrderItemId.keys()];
      if (requestedOrderItemIds.length) {
        const requestedOrderItems = await this.orderItemRepo.find(
          {
            where: {id: {inq: requestedOrderItemIds}, orderId},
          },
          options,
        );
        const totalQtyByItemId = new Map(
          requestedOrderItems.map(oi => [oi.id, Number(oi.quantity) || 0]),
        );

        const existingReturns = await this.salesReturnRepo.find(
          {
            where: {orderId, status: {neq: SalesReturnStatus.REJECTED}},
          },
          options,
        );
        const alreadyCreditedQtyByItemId = new Map<string, number>();
        for (const existing of existingReturns) {
          for (const line of (existing.returnedItems ?? []) as Array<{
            orderItemId?: string;
            quantity?: number;
          }>) {
            if (!line.orderItemId) continue;
            alreadyCreditedQtyByItemId.set(
              line.orderItemId,
              (alreadyCreditedQtyByItemId.get(line.orderItemId) ?? 0) +
                (Number(line.quantity) || 0),
            );
          }
        }

        const garments = await this.garmentRepo.find(
          {
            where: {
              orderItemId: {inq: requestedOrderItemIds},
              isDeleted: false,
            } as object,
          },
          options,
        );
        const billableQtyByItemId = new Map<string, number>();
        const garmentQtyByItemId = new Map<string, number>();
        for (const garment of garments) {
          garmentQtyByItemId.set(
            garment.orderItemId,
            (garmentQtyByItemId.get(garment.orderItemId) ?? 0) + 1,
          );
          if (
            garment.status === GarmentStatus.RETURNED_TO_CUSTOMER ||
            garment.status === GarmentStatus.DAMAGED
          )
            continue;
          billableQtyByItemId.set(
            garment.orderItemId,
            (billableQtyByItemId.get(garment.orderItemId) ?? 0) + 1,
          );
        }

        const overRequestedIds = requestedOrderItemIds.filter(id => {
          const totalQty = totalQtyByItemId.get(id) ?? 0;
          const remaining = Math.min(
            totalQty - (alreadyCreditedQtyByItemId.get(id) ?? 0),
            garmentQtyByItemId.has(id)
              ? (billableQtyByItemId.get(id) ?? 0) -
                  existingReturns
                    .filter(ret => ret.status === SalesReturnStatus.PENDING)
                    .reduce(
                      (sum, ret) =>
                        sum +
                        (ret.returnedItems ?? []).reduce((n, raw) => {
                          const line = raw as {
                            orderItemId?: string;
                            quantity?: number;
                          };
                          return (
                            n +
                            (line.orderItemId === id
                              ? Number(line.quantity) || 0
                              : 0)
                          );
                        }, 0),
                      0,
                    )
              : totalQty,
          );
          return (requestedQtyByOrderItemId.get(id) ?? 0) > remaining;
        });
        if (overRequestedIds.length) {
          const conflictingOrderItems = await this.orderItemRepo.find(
            {
              where: {id: {inq: overRequestedIds}},
            },
            options,
          );
          const itemIds = [
            ...new Set(conflictingOrderItems.map(oi => oi.itemId)),
          ];
          const items = itemIds.length
            ? await this.itemRepo.find({where: {id: {inq: itemIds}}}, options)
            : [];
          const itemNameById = new Map(items.map(it => [it.id, it.name]));
          const names = conflictingOrderItems.map(
            oi => itemNameById.get(oi.itemId) ?? 'this item',
          );
          throw new HttpErrors.Conflict(
            `${[...new Set(names)].join(', ')}: requested return quantity exceeds what's still available (already credited or returned to the customer).`,
          );
        }
      }

      const orderItems = await this.orderItemRepo.find(
        {where: {orderId}},
        options,
      );
      const previousReturns = await this.salesReturnRepo.find(
        {where: {orderId, status: {neq: SalesReturnStatus.REJECTED}}},
        options,
      );
      const previousLines = previousReturns.flatMap(
        record => record.returnedItems ?? [],
      ) as CreditLine[];
      const previousBasis = previousLines.find(
        line => line.invoiceBasis,
      )?.invoiceBasis;
      // Individual invoices retain their issued prices. Consolidated documents
      // snapshot the ticket basis on the first request because they cover a batch.
      const basis: CreditBasis = !invoice.isConsolidated
        ? {
            subtotal: money(invoice.subtotal),
            discount: money(invoice.discount),
            tax: money(Number(invoice.cgst ?? 0) + Number(invoice.sgst ?? 0)),
            total: money(invoice.totalAmount),
          }
        : (previousBasis ?? {
            subtotal: money(order.subtotal),
            discount: money(order.discountAmount),
            tax: money(order.taxAmount),
            total: money(order.totalAmount),
          });
      const snapshotItems = (invoice.items ?? []) as {
        orderItemId: string;
        quantity: number;
        totalPrice: number;
      }[];
      const allGarments = await this.garmentRepo.find(
        {
          where: {
            orderItemId: {inq: orderItems.map(item => item.id)},
            isDeleted: false,
          },
          order: ['createdAt ASC', 'id ASC'],
        },
        options,
      );
      const reservedIds = new Set(
        previousLines.flatMap(line => line.garmentIds ?? []),
      );
      const returnedItems: CreditLine[] = [];
      for (const requested of body.returnedItems ?? []) {
        const item = orderItems.find(row => row.id === requested.orderItemId);
        if (!item || item.rejectedAtIntake)
          throw new HttpErrors.BadRequest(
            'Selected item is not billable on this ticket.',
          );
        const snapshot = snapshotItems.find(row => row.orderItemId === item.id);
        if (!invoice.isConsolidated && !snapshot)
          throw new HttpErrors.BadRequest(
            'Selected item is missing from the final invoice.',
          );
        const eligible = allGarments.filter(
          garment =>
            garment.orderItemId === item.id &&
            ![
              GarmentStatus.RETURNED_TO_CUSTOMER,
              GarmentStatus.DAMAGED,
            ].includes(garment.status!) &&
            !reservedIds.has(garment.id),
        );
        const legacyReserved = previousReturns
          .filter(record => record.status === SalesReturnStatus.PENDING)
          .flatMap(record => record.returnedItems ?? [])
          .reduce((sum, raw) => {
            const line = raw as CreditLine;
            return (
              sum +
              (line.orderItemId === item.id && !line.garmentIds?.length
                ? Number(line.quantity) || 0
                : 0)
            );
          }, 0);
        const selected = eligible.slice(
          legacyReserved,
          legacyReserved + requested.quantity,
        );
        if (
          allGarments.some(garment => garment.orderItemId === item.id) &&
          selected.length !== requested.quantity
        )
          throw new HttpErrors.Conflict(
            'Selected garments are already credited or reserved by another credit note.',
          );
        let originalAmount = 0;
        for (const garment of selected) {
          const price = await this.approvalService.calculateGarmentReturnAmount(
            garment.id,
          );
          const siblings = allGarments.filter(
            row => row.orderItemId === item.id,
          );
          const area = (row: typeof garment) =>
            Math.max(0, Number(row.length) * Number(row.width)) || 0;
          const totalArea = siblings.reduce((sum, row) => sum + area(row), 0);
          const share =
            area(garment) > 0 && totalArea > 0
              ? area(garment) / totalArea
              : 1 / Math.max(1, Number(snapshot?.quantity));
          const primary = snapshot
            ? money(snapshot.totalPrice) * share
            : price.itemPrice;
          const invoiceIncludesExtras =
            invoice.isConsolidated === true ||
            basis.subtotal >
              snapshotItems.reduce(
                (sum, row) => sum + money(row.totalPrice),
                0,
              ) +
                0.01;
          originalAmount +=
            primary +
            (invoiceIncludesExtras
              ? price.additionalServiceCharge + price.addOnCharge
              : 0);
        }
        if (!selected.length)
          originalAmount =
            (money(snapshot?.totalPrice ?? item.totalPrice) *
              requested.quantity) /
            Math.max(1, Number(snapshot?.quantity ?? item.quantity));
        const amounts = invoiceCreditValue(originalAmount, basis);
        returnedItems.push({
          orderItemId: item.id,
          quantity: requested.quantity,
          originalAmount: money(originalAmount),
          ...amounts,
          garmentIds: selected.map(garment => garment.id),
          invoiceBasis: basis,
        });
      }
      const pendingCredit = previousReturns
        .filter(record => record.status === SalesReturnStatus.PENDING)
        .reduce((sum, record) => sum + money(record.creditAmount), 0);
      // Round cumulative invoice credits so separate piece returns do not
      // leave a rupee outstanding after the final piece is credited.
      const priorInvoiceNotes = previousReturns.filter(record =>
        (record.returnedItems as CreditLine[]).every(line => line.invoiceBasis),
      );
      const priorGross = priorInvoiceNotes.reduce(
        (sum, record) =>
          sum +
          (record.returnedItems as CreditLine[]).reduce(
            (n, line) => n + line.grossAmount,
            0,
          ),
        0,
      );
      const priorCredit = priorInvoiceNotes.reduce(
        (sum, record) => sum + money(record.creditAmount),
        0,
      );
      const roundedCredit =
        roundRupee(
          priorGross +
            returnedItems.reduce((sum, line) => sum + line.grossAmount, 0),
        ) - priorCredit;
      if (
        roundedCredit >
        Math.max(0, roundRupee(order.totalAmount) - pendingCredit) + 1
      ) {
        throw new HttpErrors.Conflict(
          'Selected credit exceeds the remaining invoice value. Review earlier credits and item adjustments.',
        );
      }
      const creditAmount = Math.min(
        roundedCredit,
        Math.max(0, roundRupee(order.totalAmount) - pendingCredit),
      );
      if (creditAmount <= 0)
        throw new HttpErrors.BadRequest(
          'Selected items have no remaining invoice value to credit.',
        );
      const quote = await this._previewCreditNote(
        {orderId, creditAmount} as SalesReturn,
        order,
        options,
      );
      if (preview) {
        await tx.commit();
        return {
          quote: {
            creditAmount,
            ...quote,
            invoiceNumber: invoice.invoiceNumber,
            invoiceTotal: invoice.totalAmount,
            returnedItems,
          },
        };
      }

      // Apply any refund using the method captured on submission.
      // Older callers that omit a method retain the existing wallet default.
      const refundMethod = body.refundMethod ?? RefundMethod.WALLET;
      if (refundMethod === RefundMethod.CASH) {
        if (body.cashShiftId) {
          const cashShift = await this.shiftRepo.findById(
            body.cashShiftId,
            undefined,
            options,
          );
          const scope = await this.storeScopeService.resolve(currentUser);
          if (
            cashShift.status !== ShiftStatus.OPEN ||
            !this.storeScopeService.allows(scope, cashShift.storeId)
          ) {
            throw new HttpErrors.Forbidden(
              'Cash payout shift is not open or accessible.',
            );
          }
        }
        const {refundAmount} = await this._previewCreditNote(
          {orderId, creditAmount} as SalesReturn,
          order,
          options,
        );
        const available = await this.approvalService.availableCashForOrder(
          orderId,
          body.cashShiftId,
        );
        if (
          refundAmount > 0 &&
          (available == null || refundAmount > available)
        ) {
          throw new HttpErrors.BadRequest(
            'Cash refund exceeds available cash in the store.',
          );
        }
      }
      if (refundMethod === RefundMethod.BANK_ACCOUNT) {
        const b = body.bankDetails;
        if (
          !b?.accountHolderName ||
          !b?.bankName ||
          !b?.accountNumber ||
          !b?.ifscCode
        ) {
          throw new HttpErrors.BadRequest(
            'Bank account refunds need accountHolderName, bankName, accountNumber, and ifscCode.',
          );
        }
      }

      const now = new Date();
      const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
      await this.dataSource.execute(
        "SELECT pg_advisory_xact_lock(hashtext('pressto.credit-note-number'))",
        [],
        options,
      );
      const numbers = (await this.dataSource.execute(
        "SELECT COALESCE(MAX(substring(creditnotenumber from '([0-9]+)$')::bigint), 0) + 1 AS \"nextNumber\" FROM public.sales_return WHERE creditnotenumber ~ '^CN-[0-9]{6}-[0-9]+$'",
        [],
        options,
      )) as {nextNumber: string}[];
      const count = {count: Number(numbers[0].nextNumber) - 1};
      const creditNoteNumber = `CN-${ym}-${String(count.count + 1).padStart(5, '0')}`;

      const {v4} = await import('uuid');
      const salesReturn = await this.salesReturnRepo.create(
        {
          id: v4(),
          orderId,
          invoiceId: invoice?.id,
          customerId: order.customerId,
          creditNoteNumber,
          reason: body.reason,
          remarks: body.remarks,
          returnedItems,
          creditAmount: parseFloat(creditAmount.toFixed(2)),
          status: SalesReturnStatus.PENDING,
          requestedBy: currentUser[securityId],
          refundMethod,
          cashShiftId:
            refundMethod === RefundMethod.CASH ? body.cashShiftId : undefined,
          bankDetails:
            refundMethod === RefundMethod.BANK_ACCOUNT
              ? body.bankDetails
              : undefined,
        } as Partial<SalesReturn>,
        options,
      );

      await this.applyCreditNote(salesReturn, currentUser, options);
      const appliedReturn = await this.salesReturnRepo.findById(
        salesReturn.id,
        undefined,
        options,
      );
      await tx.commit();
      return {
        message:
          'Sales return applied immediately. Credit note recorded in Finance history.',
        salesReturn: appliedReturn,
      };
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  // ─── Get Credit Note ──────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders/{orderId}/credit-note')
  @response(200, {description: 'Credit note for an order'})
  async getCreditNote(
    @param.path.string('orderId') orderId: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser?: UserProfile,
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(orderId, currentUser!);

    const order = await this.orderRepo.findOne({
      where: {id: orderId, isDeleted: false},
    });
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const salesReturn = await this.salesReturnRepo.findOne({
      where: {orderId} as any,
      order: ['createdAt DESC'],
    } as any);

    if (!salesReturn)
      throw new HttpErrors.NotFound(
        'No sales return / credit note found for this order.',
      );
    return {creditNote: salesReturn};
  }

  // ─── List Sales Returns ───────────────────────────────────────────────────
  // All returns for an order, any status — lets the New Sales Return dialog
  // know which order items already have one (see the create() guard above),
  // since getCreditNote only ever surfaces the single most recent record.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders/{orderId}/sales-returns')
  @response(200, {description: 'All sales returns for an order'})
  async listSalesReturns(
    @param.path.string('orderId') orderId: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser?: UserProfile,
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(orderId, currentUser!);

    const salesReturns = await this.salesReturnRepo.find({
      where: {orderId},
      order: ['createdAt DESC'],
    });

    return {salesReturns};
  }

  // ─── List Credit Notes (global) ────────────────────────────────────────────
  // Cross-order view for the Finance Approvals screen — listSalesReturns()
  // above only helps once you already know which order to look at.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/sales-returns')
  @response(200, {
    description:
      'Sales returns across all orders, optionally filtered by status',
  })
  async listAll(
    // Comma-separated (e.g. "pending,approved,rejected"), same convention as
    // approval-requests' `type` filter — omit entirely for every status, so
    // finance can see what they've already approved/rejected, not just
    // what's still pending.
    @param.query.string('status') status?: string,
    @param.query.number('page') page?: number,
    @param.query.number('limit') limit?: number,
    @param.query.number('skip') skip?: number,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser?: UserProfile,
  ): Promise<object> {
    const statuses = (status ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean) as SalesReturnStatus[];

    const where = statuses.length
      ? {status: statuses.length > 1 ? {inq: statuses} : statuses[0]}
      : {};

    const resolvedLimit = limit !== undefined ? Number(limit) : undefined;
    let resolvedSkip = skip !== undefined ? Number(skip) : undefined;
    if (
      resolvedSkip === undefined &&
      page !== undefined &&
      resolvedLimit !== undefined
    ) {
      const pageNum = Number(page);
      const zeroBasedPage = pageNum >= 1 ? pageNum - 1 : Math.max(0, pageNum);
      resolvedSkip = zeroBasedPage * resolvedLimit;
    }

    const salesReturns = await this.salesReturnRepo.find({
      where,
      order: ['createdAt DESC'],
    });
    if (!salesReturns.length) {
      return {
        salesReturns: [],
        total: 0,
        limit: resolvedLimit,
        skip: resolvedSkip,
        page: page ?? 1,
      };
    }

    const orderIds = [...new Set(salesReturns.map(sr => sr.orderId))];
    const orders = await this.orderRepo.find({where: {id: {inq: orderIds}}});
    const orderById = new Map(orders.map(o => [o.id, o]));

    const scope = await this.storeScopeService.resolve(currentUser!);
    // Also allow orders reachable via an active inter-store transfer grant
    // to this scope — additive, doesn't narrow anything the direct
    // storeId check already allowed.
    const transferGrantedOrderIds = scope.global
      ? []
      : await this.storeScopeService.transferGrantedOrderIds(scope.storeIds);
    const grantedOrderIdSet = new Set(transferGrantedOrderIds.map(String));
    const inScope = scope.global
      ? salesReturns
      : salesReturns.filter(sr => {
          if (grantedOrderIdSet.has(String(sr.orderId))) return true;
          const order = orderById.get(sr.orderId);
          return order
            ? this.storeScopeService.allows(scope, order.storeId)
            : false;
        });

    const total = inScope.length;

    const paged =
      resolvedLimit !== undefined
        ? inScope.slice(resolvedSkip ?? 0, (resolvedSkip ?? 0) + resolvedLimit)
        : resolvedSkip !== undefined
          ? inScope.slice(resolvedSkip)
          : inScope;

    const customerIds = [
      ...new Set(paged.map(sr => sr.customerId).filter(Boolean)),
    ];
    const customers = customerIds.length
      ? await this.customerRepo.find({where: {id: {inq: customerIds}}})
      : [];
    const customerById = new Map(customers.map(c => [c.id, c]));
    const cashShiftIds = [
      ...new Set(
        paged
          .map(sr => sr.cashShiftId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const cashShifts = cashShiftIds.length
      ? await this.shiftRepo.find({where: {id: {inq: cashShiftIds}}})
      : [];
    const cashShiftById = new Map(cashShifts.map(shift => [shift.id, shift]));

    const rows = await Promise.all(
      paged.map(async sr => {
        const order = orderById.get(sr.orderId);
        const customer = customerById.get(sr.customerId);
        // Only preview live for a still-PENDING record — approve() has
        // already reduced the order's totals by this exact return for a
        // resolved one, so re-running the same math against the
        // now-already-adjusted order would be comparing against the wrong
        // baseline. Use what was actually applied instead (sr.refundAmount,
        // stored at approve() time).
        const preview =
          sr.status === SalesReturnStatus.PENDING && order
            ? await this._previewCreditNote(sr, order)
            : {refundAmount: money(sr.refundAmount), newBalanceDue: null};
        return {
          id: sr.id,
          creditNoteNumber: sr.creditNoteNumber,
          orderId: sr.orderId,
          orderNumber: order?.orderNumber ?? null,
          customerId: sr.customerId,
          customerName: customer
            ? `${customer.firstName} ${customer.lastName}`.trim()
            : null,
          reason: sr.reason,
          remarks: sr.remarks,
          creditAmount: sr.creditAmount,
          status: sr.status,
          requestedBy: sr.requestedBy,
          createdAt: sr.createdAt,
          refundAmount: preview.refundAmount,
          newBalanceDue: preview.newBalanceDue,
          refundMethod: sr.refundMethod,
          cashStoreLabel: sr.cashShiftId
            ? [
                cashShiftById.get(sr.cashShiftId)?.storeCode,
                cashShiftById.get(sr.cashShiftId)?.storeName,
              ]
                .filter(Boolean)
                .join(' — ')
            : null,
          creditAppliedAs: sr.creditAppliedAs,
          bankDetails: sr.bankDetails,
        };
      }),
    );

    return {
      salesReturns: rows,
      total,
      limit: resolvedLimit,
      skip: resolvedSkip,
      page:
        page ??
        (resolvedSkip !== undefined && resolvedLimit
          ? Math.floor(resolvedSkip / resolvedLimit) + 1
          : 1),
    };
  }

  // ─── Approve Sales Return ─────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @post('/sales-returns/{id}/approve')
  @response(200, {description: 'Sales return approved'})
  async approve(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<object> {
    const initial = await this.salesReturnRepo.findById(id);
    await this.storeScopeService.assertOrderVisible(
      initial.orderId,
      currentUser,
    );
    const tx = await this.dataSource.beginTransaction({
      isolationLevel: 'READ COMMITTED',
    });
    const options = {transaction: tx};
    try {
      await this.dataSource.execute(
        'SELECT id FROM public.orders WHERE id = $1 FOR UPDATE',
        [initial.orderId],
        options,
      );
      const record = await this.salesReturnRepo.findById(
        id,
        undefined,
        options,
      );
      if (!record) throw new HttpErrors.NotFound('Sales return not found.');
      if (record.status !== SalesReturnStatus.PENDING) {
        throw new HttpErrors.BadRequest(
          `Sales return is already ${record.status}.`,
        );
      }

      const result = await this.applyCreditNote(record, currentUser, options);
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  /** Apply a credit and any refund once, inside the caller's locked transaction. */
  private async applyCreditNote(
    record: SalesReturn,
    currentUser: UserProfile,
    options: Options,
  ): Promise<{message: string; creditNoteNumber?: string}> {
    if (record.status !== SalesReturnStatus.PENDING) {
      throw new HttpErrors.BadRequest(
        `Sales return is already ${record.status}.`,
      );
    }
    const id = record.id;
    const tx = options.transaction;
    const order = await this.orderRepo.findOne(
      {
        where: {id: record.orderId, isDeleted: false},
      },
      options,
    );
    if (!order) throw new HttpErrors.NotFound('Order not found.');
    if (
      ![
        OrderStatus.READY,
        OrderStatus.PARTIALLY_DISPATCHED,
        OrderStatus.OUT_FOR_DELIVERY,
        OrderStatus.DELIVERED,
        OrderStatus.RETURNED,
      ].includes(order.status!)
    ) {
      throw new HttpErrors.Conflict(
        'Ticket is no longer eligible for a credit note.',
      );
    }
    if (
      money(record.creditAmount) <= 0 ||
      money(record.creditAmount) > money(order.totalAmount) + 1
    ) {
      throw new HttpErrors.Conflict(
        'Credit no longer matches the remaining ticket value. Reject and recreate it.',
      );
    }

    const {v4} = await import('uuid');
    // New sales returns settle during creation. Older pending notes use the
    // same operation when approved. Refunds share the credit transaction.
    const {newOrderTotal, refundAmount, newBalanceDue} =
      await this._previewCreditNote(record, order, options);
    if (refundAmount > 0 && record.refundMethod === RefundMethod.CASH) {
      const available = await this.approvalService.availableCashForOrder(
        record.orderId,
        record.cashShiftId,
      );
      if (available == null || refundAmount > available) {
        throw new HttpErrors.BadRequest(
          'Cash refund exceeds available cash in the store.',
        );
      }
    }
    let invoice = record.invoiceId
      ? await this.invoiceRepo.findById(record.invoiceId, undefined, options)
      : await this.findInvoiceForOrder(record.orderId, options);
    if (!invoice || invoice.status !== InvoiceStatus.ISSUED)
      throw new HttpErrors.BadRequest(
        'A final invoice is required to approve a credit note.',
      );
    await this.dataSource.execute(
      'SELECT id FROM public.invoice WHERE id = $1 FOR UPDATE',
      [invoice.id],
      options,
    );
    invoice = await this.invoiceRepo.findById(invoice.id, undefined, options);
    const invoiceLink = invoice?.isConsolidated
      ? await this.invoiceOrderLinkRepo.findOne(
          {
            where: {invoiceId: invoice.id, orderId: record.orderId},
          },
          options,
        )
      : null;
    if (invoice?.isConsolidated && !invoiceLink) {
      throw new HttpErrors.Conflict(
        'Order is missing from its on-account invoice.',
      );
    }

    // New notes retain the issued invoice discount and GST; older notes keep
    // their existing pricing behavior. Payment state only affects the refund.
    const gstRate = await this._resolveGstRate();
    const preTaxCreditAmount = money(
      (record.returnedItems ?? []).reduce(
        (sum, item) => sum + (Number((item as {amount?: unknown}).amount) || 0),
        0,
      ),
    );
    const rawReturnedAmount = money(
      (record.returnedItems ?? []).reduce(
        (sum, item) =>
          sum +
          (Number((item as {originalAmount?: unknown}).originalAmount) ||
            Number((item as {amount?: unknown}).amount) ||
            0),
        0,
      ),
    );
    const returnedDiscount = money(
      Math.max(0, rawReturnedAmount - preTaxCreditAmount),
    );
    const newSubtotal = money(
      Math.max(0, money(order.subtotal) - rawReturnedAmount),
    );
    const newDiscount = money(
      Math.max(0, money(order.discountAmount) - returnedDiscount),
    );
    // Recompute tax fresh from the new subtotal rather than leaving
    // order.taxAmount stale — a stale taxAmount would corrupt a *later*
    // credit note on this same order the same way this one was corrupted
    // by an earlier Upgrade (see approval.service.ts's
    // _applyUpgradeOnOrderItem, fixed the same way).
    const newTaxableAmount = money(newSubtotal - newDiscount);
    const invoiceLines = record.returnedItems as CreditLine[];
    const newTaxAmount = invoiceLines.every(line => line.invoiceBasis)
      ? money(
          Math.max(
            0,
            money(order.taxAmount) -
              invoiceLines.reduce(
                (sum, line) => sum + money(line.taxAmount),
                0,
              ),
          ),
        )
      : gstRate > 0
        ? money((newTaxableAmount * gstRate) / 100)
        : 0;

    await this.orderRepo.updateById(
      record.orderId,
      {
        subtotal: newSubtotal,
        discountAmount: newDiscount,
        taxAmount: newTaxAmount,
        totalAmount: newOrderTotal,
        updatedAt: new Date(),
      } as any,
      options,
    );

    // Make the returned lines visible to every invoice/challan renderer. The
    // documents identify returned pieces from garment status, so adjusting
    // only the money would leave those items looking active on printouts.
    for (const line of (record.returnedItems ?? []) as Array<{
      orderItemId?: string;
      quantity?: number;
    }>) {
      if (!line.orderItemId) continue;
      const garments = await this.garmentRepo.find(
        {
          where: {
            orderItemId: line.orderItemId,
            ...((line as CreditLine).garmentIds?.length
              ? {id: {inq: (line as CreditLine).garmentIds}}
              : {}),
            status: {
              nin: [GarmentStatus.RETURNED_TO_CUSTOMER, GarmentStatus.DAMAGED],
            },
            isDeleted: false,
          } as object,
          order: ['createdAt ASC'],
        },
        options,
      );
      const quantity = Math.max(0, Number(line.quantity) || 0);
      if (
        (line as CreditLine).garmentIds?.length &&
        garments.length !== quantity
      )
        throw new HttpErrors.Conflict(
          'Selected garments changed after this credit note was requested. Reject and recreate it.',
        );
      for (const garment of garments.slice(0, quantity)) {
        await this.garmentRepo.updateById(
          garment.id,
          {
            status: GarmentStatus.RETURNED_TO_CUSTOMER,
          },
          options,
        );
      }
    }

    if (invoice) {
      if (invoice.isConsolidated && invoiceLink) {
        const credit = Math.min(
          money(invoiceLink.orderTotal),
          money(record.creditAmount),
        );
        {
          await this.invoiceRepo.updateById(
            invoice.id,
            {
              balanceDue: roundRupee(
                Math.max(0, money(invoice.balanceDue) - credit),
              ),
              updatedAt: new Date(),
            },
            {transaction: tx},
          );
          await this.invoiceOrderLinkRepo.updateById(
            invoiceLink.id,
            {
              orderTotal: money(
                Math.max(0, money(invoiceLink.orderTotal) - credit),
              ),
            },
            {transaction: tx},
          );
        }
      } else {
        await this.invoiceRepo.updateById(
          invoice.id,
          {
            balanceDue: newBalanceDue,
            updatedAt: new Date(),
          } as any,
          options,
        );
      }
    }

    // Always reflect the reduced order value on the challan if it exists
    const challan = await this.challanRepo.findOne(
      {
        where: {orderId: record.orderId},
      } as any,
      options,
    );
    if (challan) {
      await this.challanRepo.updateById(
        challan.id,
        {
          totalAmount: newOrderTotal,
          subtotal: newSubtotal,
          discount: newDiscount,
          cgst: money(newTaxAmount / 2),
          sgst: money(newTaxAmount - money(newTaxAmount / 2)),
          updatedAt: new Date(),
        } as any,
        options,
      );
    }

    if (refundAmount > 0) {
      await this.approvalService.executeRefundPayout(
        {
          customerId: record.customerId,
          orderId: record.orderId,
          amount: refundAmount,
          method: record.refundMethod ?? RefundMethod.WALLET,
          cashShiftId: record.cashShiftId,
          bankDetails: record.bankDetails as RefundBankDetails | undefined,
          remarks: `Sales Return Credit Note: ${record.creditNoteNumber}`,
        },
        options,
      );
    }

    await this.salesReturnRepo.updateById(
      id,
      {
        status: SalesReturnStatus.APPROVED,
        ...(invoice && !record.invoiceId ? {invoiceId: invoice.id} : {}),
        resolvedBy: currentUser[securityId],
        resolvedAt: new Date(),
        refundAmount,
        returnedItems: (record.returnedItems ?? []).map(line => ({
          ...line,
          preservesInvoice: true,
        })),
        creditAppliedAs:
          refundAmount > 0
            ? (record.refundMethod ?? RefundMethod.WALLET)
            : 'adjustment',
      } as Partial<SalesReturn>,
      options,
    );

    // If every item on the order now has an approved return covering its full
    // quantity, the order itself is done — nothing is left to deliver/track.
    // ORDER_STATUS_TRANSITIONS only allows this jump from a post-fulfillment
    // state, so an order returned before it ever reached that stage is left
    // as-is rather than forced into an invalid transition.
    const orderItems = await this.orderItemRepo.find(
      {
        where: {orderId: record.orderId} as any,
      },
      options,
    );
    const approvedReturns = await this.salesReturnRepo.find(
      {
        where: {
          orderId: record.orderId,
          status: SalesReturnStatus.APPROVED,
        } as any,
      },
      options,
    );
    const returnedQtyByItem = new Map<string, number>();
    for (const ret of approvedReturns) {
      for (const line of (ret.returnedItems ?? []) as Array<{
        orderItemId?: string;
        quantity?: number;
      }>) {
        if (!line.orderItemId) continue;
        returnedQtyByItem.set(
          line.orderItemId,
          (returnedQtyByItem.get(line.orderItemId) ?? 0) +
            (Number(line.quantity) || 0),
        );
      }
    }
    const fullyReturned =
      orderItems.length > 0 &&
      orderItems.every(
        oi => (returnedQtyByItem.get(oi.id) ?? 0) >= (Number(oi.quantity) || 0),
      );

    if (
      fullyReturned &&
      ORDER_STATUS_TRANSITIONS[order.status!]?.includes(OrderStatus.RETURNED)
    ) {
      await this.orderRepo.updateById(
        record.orderId,
        {
          status: OrderStatus.RETURNED,
        },
        options,
      );
      await this.statusHistoryRepo.create(
        {
          id: v4(),
          orderId: record.orderId,
          status: OrderStatus.RETURNED,
          changedAt: new Date(),
          changedBy: currentUser[securityId],
          remarks: `Auto-set: all items returned via credit note ${record.creditNoteNumber}`,
        },
        options,
      );
    }

    return {
      message: 'Sales return applied. Credit note issued.',
      creditNoteNumber: record.creditNoteNumber,
    };
  }

  // ─── Reject Sales Return ───────────────────────────────────────────────────
  // The only other place a PENDING credit note can go — status was already
  // in the enum, it was just never reachable via any endpoint.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @post('/sales-returns/{id}/reject')
  @response(200, {description: 'Sales return rejected'})
  async reject(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body?: {remarks?: string},
  ): Promise<object> {
    const initial = await this.salesReturnRepo.findById(id);
    await this.storeScopeService.assertOrderVisible(
      initial.orderId,
      currentUser,
    );
    const tx = await this.dataSource.beginTransaction({
      isolationLevel: 'READ COMMITTED',
    });
    const options = {transaction: tx};
    try {
      await this.dataSource.execute(
        'SELECT id FROM public.orders WHERE id = $1 FOR UPDATE',
        [initial.orderId],
        options,
      );
      const record = await this.salesReturnRepo.findById(
        id,
        undefined,
        options,
      );
      if (!record) throw new HttpErrors.NotFound('Sales return not found.');
      if (record.status !== SalesReturnStatus.PENDING) {
        throw new HttpErrors.BadRequest(
          `Sales return is already ${record.status}.`,
        );
      }

      await this.salesReturnRepo.updateById(
        id,
        {
          status: SalesReturnStatus.REJECTED,
          resolvedBy: currentUser[securityId],
          resolvedAt: new Date(),
          remarks: body?.remarks ?? record.remarks,
        } as Partial<SalesReturn>,
        options,
      );

      await tx.commit();
      return {
        message: 'Sales return rejected.',
        creditNoteNumber: record.creditNoteNumber,
      };
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
}
