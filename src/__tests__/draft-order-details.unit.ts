import {expect} from '@loopback/testlab';
import {OrderStatus} from '../models/order-status.enum';
import {OrderType} from '../models/order-type.enum';
import {PickupRequestStatus} from '../models/pickup-request-status.enum';
import {OrderController} from '../controllers/order.controller';
import {OrderService} from '../services/order.service';
import {StoreScopeService} from '../services/store-scope.service';

describe('draft ticket details', () => {
  it('dates a confirmed draft from ticket submission, not draft creation', async () => {
    let updated: Record<string, unknown> = {};
    let changedAt: Date | undefined;
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {beginTransaction: async () => ({commit: async () => {}, rollback: async () => {}}),
        execute: async () => {}},
      orderRepo: {
        findOne: async () => ({id: 'draft-1', status: OrderStatus.DRAFT,
          createdAt: new Date('2026-10-15T10:00:00Z'),
          deliveryDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
          draftEditorState: {deliveryDateAnchor: new Date().toISOString()}}),
        updateById: async (_id: string, fields: Record<string, unknown>) => {updated = fields;},
      },
      statusHistoryRepo: {create: async (row: {changedAt: Date}) => {changedAt = row.changedAt;}},
      couponRedemptionRepo: {find: async () => []},
      notifyStatusChange: () => {},
    }) as OrderService;
    await service.changeStatus('draft-1', OrderStatus.CONFIRMED, 'staff-1');
    expect(updated).to.containEql({status: OrderStatus.CONFIRMED, draftEditorState: null});
    expect(updated.createdAt).to.be.instanceOf(Date);
    expect(updated.createdAt).to.eql(changedAt);
    expect((updated.createdAt as Date).getTime()).to.be.greaterThan(new Date('2026-10-15T10:00:00Z').getTime());
    updated = {};
    await service.changeStatus('draft-1', OrderStatus.CANCELLED, 'staff-1');
    expect(updated).to.not.have.property('createdAt');
  });
  it('requires a stale draft delivery promise to be refreshed before confirmation', async () => {
    let updated = false;
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {beginTransaction: async () => ({commit: async () => {}, rollback: async () => {}}),
        execute: async () => {}},
      orderRepo: {
        findOne: async () => ({status: OrderStatus.DRAFT,
          createdAt: new Date('2026-10-15T10:00:00Z'),
          deliveryDate: new Date('2026-10-17T10:00:00Z'),
          draftEditorState: {deliveryDateAnchor: '2026-10-15T10:00:00Z'}}),
        updateById: async () => {updated = true;},
      },
      couponRedemptionRepo: {find: async () => []},
    }) as OrderService;
    await expect(service.changeStatus('draft-1', OrderStatus.CONFIRMED, 'staff-1'))
      .to.be.rejectedWith(/Save the draft before submitting/);
    expect(updated).to.equal(false);
  });

  it('rolls back receipt when garment inspection persistence fails', async () => {
    const steps: string[] = [];
    const tx = {commit: async () => {steps.push('commit');}, rollback: async () => {steps.push('rollback');}};
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {beginTransaction: async () => tx,
        execute: async (_sql: string, _params: unknown, options: {transaction: unknown}) => {
          expect(options.transaction).to.equal(tx);
          steps.push('lock');
        }},
      orderRepo: {findOne: async () => ({status: OrderStatus.CONFIRMED}),
        updateById: async () => {steps.push('status');}},
      autoCreateGarments: async (_id: string, _staff: string, _v4: unknown, transaction: unknown) => {
        expect(transaction).to.equal(tx);
        steps.push('inspection');
        throw new Error('inspection failed');
      },
    }) as OrderService;
    await expect(service.changeStatus('order-1', OrderStatus.RECEIVED_AT_STORE, 'staff-1'))
      .to.be.rejectedWith('inspection failed');
    expect(steps).to.deepEqual(['lock', 'inspection', 'rollback']);
  });

  it('commits receipt only after garments, status and history are saved', async () => {
    const steps: string[] = [];
    const tx = {commit: async () => {steps.push('commit');}, rollback: async () => {steps.push('rollback');}};
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {beginTransaction: async () => tx, execute: async () => {steps.push('lock');}},
      orderRepo: {findOne: async () => ({status: OrderStatus.CONFIRMED}),
        updateById: async (_id: string, _fields: unknown, options: {transaction: unknown}) => {
          expect(options.transaction).to.equal(tx);
          steps.push('status');
        }},
      autoCreateGarments: async () => {steps.push('garments'); return [{id: 'garment-1'}];},
      statusHistoryRepo: {create: async (_row: unknown, options: {transaction: unknown}) => {
        expect(options.transaction).to.equal(tx);
        steps.push('history');
      }},
      notifyStatusChange: () => {steps.push('notify');},
    }) as OrderService;
    const result = await service.changeStatus('order-1', OrderStatus.RECEIVED_AT_STORE, 'staff-1');
    expect(result).to.deepEqual({garments: [{id: 'garment-1'}]});
    expect(steps).to.deepEqual(['lock', 'garments', 'status', 'history', 'commit', 'notify']);
  });
  it('submits a store-dropoff draft and receives garments in one transaction', async () => {
    const steps: string[] = [];
    const tx = {commit: async () => {steps.push('commit');}, rollback: async () => {steps.push('rollback');}};
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {beginTransaction: async () => tx, execute: async () => {steps.push('lock');}},
      orderRepo: {findOne: async () => ({id: 'draft-1', status: OrderStatus.DRAFT,
        orderType: OrderType.STORE_DROPOFF}),
        updateById: async (_id: string, fields: {createdAt: Date}) => {
          expect(fields.createdAt).to.be.instanceOf(Date);
          steps.push('status');
        }},
      couponRedemptionRepo: {find: async () => []},
      autoCreateGarments: async () => {steps.push('garments'); return [{id: 'garment-1'}];},
      statusHistoryRepo: {create: async (row: {status: OrderStatus}) => {steps.push(row.status);}},
      notifyStatusChange: () => {},
    }) as OrderService;
    const result = await service.changeStatus('draft-1', OrderStatus.RECEIVED_AT_STORE, 'staff-1');
    expect(result).to.deepEqual({garments: [{id: 'garment-1'}]});
    expect(steps).to.deepEqual(['lock', 'garments', 'status', OrderStatus.CONFIRMED,
      OrderStatus.RECEIVED_AT_STORE, 'commit']);
  });
  it('receives a linked pickup draft atomically after the pickup reaches its store', async () => {
    const steps: string[] = [];
    const tx = {commit: async () => {steps.push('commit');}, rollback: async () => {steps.push('rollback');}};
    const order = {id: 'draft-1', status: OrderStatus.DRAFT, orderType: OrderType.HOME_PICKUP,
      customerId: 'customer-1', storeId: 'store-1', draftEditorState: {pickupRequestId: 'pickup-1'}};
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {beginTransaction: async () => tx, execute: async () => {steps.push('lock');}},
      orderRepo: {findOne: async () => order, updateById: async () => {steps.push('status');}},
      pickupRequestRepo: {findOne: async () => ({id: 'pickup-1', status: PickupRequestStatus.RECEIVED_AT_STORE,
        customerId: 'customer-1', storeId: 'store-1'})},
      couponRedemptionRepo: {find: async () => []},
      autoCreateGarments: async () => {steps.push('garments'); return [];},
      statusHistoryRepo: {create: async (row: {status: OrderStatus}) => {steps.push(row.status);}},
      notifyStatusChange: () => {},
    }) as OrderService;
    await service.changeStatus('draft-1', OrderStatus.RECEIVED_AT_STORE, 'staff-1');
    expect(steps).to.deepEqual(['lock', 'garments', 'status', OrderStatus.CONFIRMED,
      OrderStatus.RECEIVED_AT_STORE, 'commit']);
  });
  it('keeps a pickup draft unsubmitted when its pickup has not reached the store', async () => {
    const steps: string[] = [];
    const order = {id: 'draft-1', status: OrderStatus.DRAFT, orderType: OrderType.HOME_PICKUP,
      customerId: 'customer-1', storeId: 'store-1', pickupRequestId: 'pickup-1'};
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {beginTransaction: async () => ({commit: async () => {steps.push('commit');},
        rollback: async () => {steps.push('rollback');}}), execute: async () => {}},
      orderRepo: {findOne: async () => order, updateById: async () => {steps.push('status');}},
      pickupRequestRepo: {findOne: async () => ({id: 'pickup-1', status: PickupRequestStatus.PICKED_UP,
        customerId: 'customer-1', storeId: 'store-1'})},
    }) as OrderService;
    await expect(service.changeStatus('draft-1', OrderStatus.RECEIVED_AT_STORE, 'staff-1'))
      .to.be.rejectedWith(/Receive the matching pickup request/);
    expect(steps).to.deepEqual(['rollback']);
  });
  it('reverses provisional coupon selections when cancelling a draft', async () => {
    const writes: (object | string)[] = [];
    const tx = {commit: async () => {writes.push('commit');}, rollback: async () => {writes.push('rollback');}};
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {beginTransaction: async () => tx, execute: async () => {}},
      orderRepo: {findOne: async () => ({id: 'draft-1', status: OrderStatus.DRAFT}),
        updateById: async (_id: string, fields: object) => {writes.push(fields);}},
      couponRedemptionRepo: {find: async () => [{id: 'redemption-1'}],
        updateById: async (_id: string, fields: object) => {writes.push(fields);}},
      statusHistoryRepo: {create: async () => {}}, notifyStatusChange: () => {},
    }) as OrderService;
    await service.changeStatus('draft-1', OrderStatus.CANCELLED, 'staff-1');
    expect(writes[0]).to.containEql({isReversed: true});
    expect(writes[0]).to.have.property('reversedAt');
    expect(writes[1]).to.containEql({status: OrderStatus.CANCELLED});
    expect(writes[2]).to.equal('commit');
  });
  it('rejects a referral coupon if another ticket was created after the draft', async () => {
    const steps: string[] = [];
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {beginTransaction: async () => ({commit: async () => {steps.push('commit');},
        rollback: async () => {steps.push('rollback');}}), execute: async () => {}},
      orderRepo: {findOne: async () => ({id: 'draft-1', status: OrderStatus.DRAFT,
        customerId: 'customer-1', storeId: 'store-1'}), count: async (where: object) => {
        expect(where).to.containEql({customerId: 'customer-1', id: {neq: 'draft-1'}});
        return {count: 1};
      }, updateById: async () => {steps.push('status');}},
      couponRedemptionRepo: {find: async () => [{id: 'redemption-1', couponId: 'referral-1',
        customerId: 'customer-1', couponCodeSnapshot: 'REFERRED', isProvisional: true}]},
      customerRepo: {findById: async () => ({referredByCouponId: 'referral-1'})},
      lockCustomerForOrder: async () => {steps.push('customer lock');},
    }) as OrderService;
    await expect(service.changeStatus('draft-1', OrderStatus.CONFIRMED, 'staff-1'))
      .to.be.rejectedWith(/Referral coupon is only available/);
    expect(steps).to.deepEqual(['customer lock', 'rollback']);
  });
  it('does not finalize a draft coupon if its use is no longer available', async () => {
    const steps: string[] = [];
    const tx = {commit: async () => {steps.push('commit');}, rollback: async () => {steps.push('rollback');}};
    const redemption = {id: 'redemption-1', couponId: 'coupon-1', customerId: 'customer-1', couponCodeSnapshot: 'SAVE10',
      discountAmount: 10, isProvisional: true};
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {beginTransaction: async () => tx, execute: async () => {}},
      orderRepo: {findOne: async () => ({id: 'draft-1', status: OrderStatus.DRAFT,
        customerId: 'customer-1', storeId: 'store-1'}), updateById: async () => {steps.push('status');}},
      couponRedemptionRepo: {find: async () => [redemption], updateById: async () => {steps.push('redeem');}},
      customerRepo: {findById: async () => ({})}, lockCustomerForOrder: async () => {},
      orderItemRepo: {find: async () => [{serviceId: 'service-1', itemId: 'item-1', quantity: 1, totalPrice: 100}]},
      couponService: {evaluateMultiple: async () => ({valid: true, coupons: [{couponId: 'coupon-1',
        discountAmount: 10}]}), redemptionCapacityReason: async () => 'Coupon limit reached.'},
      lockCouponCodes: async () => {},
    }) as OrderService;
    await expect(service.changeStatus('draft-1', OrderStatus.CONFIRMED, 'staff-1'))
      .to.be.rejectedWith('Coupon limit reached.');
    expect(steps).to.deepEqual(['rollback']);
  });
  it('commits a provisional coupon use only when the draft becomes a ticket', async () => {
    const writes: Record<string, unknown> = {};
    const tx = {commit: async () => {writes.committed = true;}, rollback: async () => {writes.rolledBack = true;}};
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {beginTransaction: async () => tx, execute: async () => {}},
      orderRepo: {findOne: async () => ({id: 'draft-1', status: OrderStatus.DRAFT,
        customerId: 'customer-1', storeId: 'store-1'}), updateById: async () => {}},
      couponRedemptionRepo: {find: async () => [{id: 'redemption-1', couponId: 'coupon-1', customerId: 'customer-1',
        couponCodeSnapshot: 'SAVE10', discountAmount: 10, isProvisional: true}],
        updateById: async (_id: string, fields: object) => {writes.redemption = fields;}},
      customerRepo: {findById: async () => ({})}, lockCustomerForOrder: async () => {},
      orderItemRepo: {find: async () => [{serviceId: 'service-1', itemId: 'item-1', quantity: 1, totalPrice: 100}]},
      couponService: {evaluateMultiple: async () => ({valid: true, coupons: [{couponId: 'coupon-1',
        discountAmount: 10}]}), redemptionCapacityReason: async () => null},
      couponRepo: {findById: async () => ({totalUsesCount: 3}),
        updateById: async (_id: string, fields: object) => {writes.coupon = fields;}},
      statusHistoryRepo: {create: async () => {}},
      lockCouponCodes: async () => {}, notifyStatusChange: () => {},
    }) as OrderService;
    await service.changeStatus('draft-1', OrderStatus.CONFIRMED, 'staff-1');
    expect(writes.redemption).to.containEql({isProvisional: false});
    expect(writes.coupon).to.containEql({totalUsesCount: 4});
    expect(writes.committed).to.equal(true);
    expect(writes.rolledBack).to.equal(undefined);
  });
  it('keeps a submitted ticket coupon when items are repriced', async () => {
    let savedOrder: Record<string, unknown> = {};
    let redeemedAmount = 100;
    let eligibleSubtotal = 50;
    const bookingSnapshot = {bookedDiscountAmount: 100,
      coupon: {id: 'coupon-1', code: 'SAVE100', name: 'Original offer',
        discountType: 'fixed', discountValue: 100, itemIds: ['shirt']}};
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderRepo: {
        findById: async () => ({id: 'order-1', customerId: 'customer-1', storeId: 'store-1', status: OrderStatus.CONFIRMED}),
        updateById: async (_id: string, fields: Record<string, unknown>) => {savedOrder = fields;},
      },
      customerRepo: {findById: async () => ({})},
      orderItemRepo: {find: async () => [{serviceId: 'clean', itemId: 'shirt', quantity: 1, totalPrice: eligibleSubtotal}]},
      orderItemChargeRepo: {find: async () => []},
      orderChargeRepo: {find: async () => []},
      couponRedemptionRepo: {
        find: async () => [{id: 'redemption-1', couponId: 'coupon-1', couponCodeSnapshot: 'SAVE100',
          discountType: 'fixed', discountAmount: redeemedAmount, bookingSnapshot}],
        updateById: async (_id: string, fields: {discountAmount: number}) => {redeemedAmount = fields.discountAmount;},
      },
      couponService: {evaluateMultiple: async (_input: unknown, existing: boolean, booked: object[]) => {
        expect(existing).to.equal(true);
        expect(booked).to.deepEqual([bookingSnapshot.coupon]);
        return {valid: true, coupons: [{couponId: 'coupon-1', eligibleSubtotal,
          discountAmount: bookingSnapshot.coupon.discountType === 'percentage'
            ? eligibleSubtotal * bookingSnapshot.coupon.discountValue / 100
            : Math.min(bookingSnapshot.coupon.discountValue, eligibleSubtotal)}]};
      }},
      resolveCustomerAutoDiscount: async () => {throw new Error('coupon must not be replaced');},
      gstConfigRepo: {findOne: async () => null},
      paymentTransactionRepo: {find: async () => []},
      invoiceRepo: {findOne: async () => null},
      challanRepo: {findOne: async () => null},
    }) as OrderService;

    const recalculate = (service as unknown as {recalculateOrderTotals: (id: string) => Promise<object>}).recalculateOrderTotals;
    await recalculate.call(service, 'order-1');
    expect(savedOrder).to.containEql({discountAmount: 50, totalAmount: 0});
    expect(redeemedAmount).to.equal(50);
    eligibleSubtotal = 200;
    await recalculate.call(service, 'order-1');
    expect(savedOrder).to.containEql({discountAmount: 100, totalAmount: 100});
    expect(redeemedAmount).to.equal(100);

    bookingSnapshot.bookedDiscountAmount = 10;
    bookingSnapshot.coupon.discountType = 'percentage';
    bookingSnapshot.coupon.discountValue = 10;
    redeemedAmount = 10;
    eligibleSubtotal = 50;
    await recalculate.call(service, 'order-1');
    expect(savedOrder).to.containEql({discountAmount: 5, totalAmount: 45});
    expect(redeemedAmount).to.equal(5);
  });

  it('keeps an old booked coupon amount without using changed live coupon terms', async () => {
    let subtotal = 200;
    let savedOrder: Record<string, unknown> = {};
    const redemption = {id: 'old-redemption', couponId: 'coupon-1', couponCodeSnapshot: 'OLD',
      discountType: 'percentage', discountAmount: 100,
      bookingSnapshot: {bookedDiscountAmount: 100}};
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderRepo: {findById: async () => ({id: 'order-1', customerId: 'customer-1',
        status: OrderStatus.CONFIRMED}),
      updateById: async (_id: string, fields: Record<string, unknown>) => {savedOrder = fields;}},
      customerRepo: {findById: async () => ({})},
      orderItemRepo: {find: async () => [{totalPrice: subtotal}]},
      orderItemChargeRepo: {find: async () => []},
      orderChargeRepo: {find: async () => []},
      couponRedemptionRepo: {find: async () => [redemption],
        updateById: async (_id: string, fields: {discountAmount: number}) => {
          redemption.discountAmount = fields.discountAmount;
        }},
      couponService: {evaluateMultiple: async () => {throw new Error('live coupon terms were read');}},
      gstConfigRepo: {findOne: async () => null},
      paymentTransactionRepo: {find: async () => []},
      invoiceRepo: {findOne: async () => null},
      challanRepo: {findOne: async () => null},
    }) as OrderService;
    const recalculate = (service as unknown as {recalculateOrderTotals: (id: string) => Promise<object>}).recalculateOrderTotals;

    await recalculate.call(service, 'order-1');
    expect(savedOrder).to.containEql({discountAmount: 100});
    subtotal = 50;
    await recalculate.call(service, 'order-1');
    expect(savedOrder).to.containEql({discountAmount: 50});
    expect(redemption.discountAmount).to.equal(50);
    subtotal = 200;
    await recalculate.call(service, 'order-1');
    expect(savedOrder).to.containEql({discountAmount: 100});
    expect(redemption.discountAmount).to.equal(100);
  });

  it('rejects a submitted item edit when its booked coupon has no qualifying items', async () => {
    let committed = false;
    let rolledBack = false;
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderRepo: {findOne: async () => ({id: 'order-1', storeId: 'store-1', customerId: 'customer-1',
        status: OrderStatus.CONFIRMED, deliveryTypePercentage: 0})},
      orderItemRepo: {find: async () => [], create: async () => ({id: 'item-1'})},
      orderItemChargeRepo: {deleteAll: async () => {}},
      garmentRepo: {find: async () => []},
      serviceRepo: {findOne: async () => ({name: 'Clean'})},
      itemRepo: {findById: async () => ({name: 'Shirt'})},
      dataSource: {beginTransaction: async () => ({
        commit: async () => {committed = true;}, rollback: async () => {rolledBack = true;},
      })},
      assertItemsHaveRequiredAdditionalServices: async () => {},
      getReprocessOriginalLines: async () => new Map(),
      collectRemovableGarments: async () => [],
      resolveAdditionalChargePercentage: async () => 0,
      resolvePricing: async () => ({basePrice: 200, resolvedPrice: 200, priceSource: 'catalog'}),
      normalizeAdditionalCharges: () => [],
      recalculateOrderTotals: async () => {throw new Error('Coupon no longer applies');},
    }) as OrderService;

    await expect(service.updateOrderItems('order-1', [
      {serviceId: 'clean', itemId: 'shirt', quantity: 1},
    ], 'staff-1')).to.be.rejectedWith('Coupon no longer applies');
    expect(committed).to.equal(false);
    expect(rolledBack).to.equal(true);
  });

  it('replaces charges and coupon redemption while keeping the ticket on account', async () => {
    const writes: Record<string, unknown> = {};
    const steps: string[] = [];
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderRepo: {
        findOne: async () => ({id: 'draft-1', customerId: 'customer-1', storeId: 'store-1',
          status: OrderStatus.DRAFT, draftEditorState: {inspectionStarted: true}}),
        updateById: async (_id: string, fields: object) => { writes.order = fields; },
      },
      customerRepo: {findById: async () => ({customerEntityType: 'business'})},
      orderItemRepo: {find: async () => [{serviceId: 'service-1', itemId: 'item-1', quantity: 1, totalPrice: 200}]},
      couponRedemptionRepo: {
        find: async () => [{id: 'old-redemption', couponId: 'coupon-1', couponCodeSnapshot: 'ONCE', customerId: 'customer-1', isProvisional: true}],
        updateById: async (_id: string, fields: object) => { writes.reversed = fields; },
        create: async (row: object) => { writes.redemption = row; },
      },
      couponService: {evaluateMultiple: async () => {steps.push('evaluate'); return {valid: true, coupons: [{
        couponId: 'coupon-1', code: 'ONCE', discountType: 'percentage', discountAmount: 20,
        pricingSnapshot: {id: 'coupon-1', code: 'ONCE', name: 'Once', discountType: 'percentage',
          discountValue: 10, itemIds: ['item-1'], itemCategoryIds: ['category-1'],
          itemCategoryById: {'item-1': 'category-1'}},
      }]}; }},
      additionalChargeRepo: {findOne: async () => ({defaultAmount: 30})},
      resolveAdditionalChargePercentage: async () => 0,
      normalizeAdditionalCharges: (rows: unknown) => rows,
      applyAdditionalChargeUplift: (amount: number) => amount,
      orderChargeRepo: {
        deleteAll: async () => { writes.chargesCleared = true; },
        create: async (row: object) => { writes.charge = row; },
      },
      couponRepo: {findById: async () => {throw new Error('live coupon rules were read again');},
        updateById: async () => {throw new Error('unchanged coupon should not use an extra redemption');}},
      dataSource: {
        execute: async (sql: string) => {if (sql.includes('coupon')) steps.push('lock coupon');},
        beginTransaction: async () => ({commit: async () => {steps.push('commit');}, rollback: async () => {}}),
      },
      recalculateOrderTotals: async () => {steps.push('recalculate'); return {totalAmount: 227};},
    }) as OrderService;

    const result = await service.updateDraftDetails('draft-1', {
      additionalChargeIds: [{additionalChargeId: 'charge-1', quantity: 1}],
      couponCodes: ['ONCE'], paymentIsOnAccount: true,
    });

    expect(writes.chargesCleared).to.equal(true);
    expect(writes.charge).to.containEql({additionalChargeId: 'charge-1', amount: 30});
    expect(writes.reversed).to.containEql({isReversed: true});
    expect(writes.redemption).to.containEql({couponCodeSnapshot: 'ONCE', discountAmount: 20});
    const booking = (writes.redemption as {bookingSnapshot: {bookedDiscountAmount: number;
      coupon: {id: string; code: string; itemIds: string[]}}}).bookingSnapshot;
    expect(booking.bookedDiscountAmount).to.equal(20);
    expect(booking.coupon).to.containEql({id: 'coupon-1', code: 'ONCE', itemIds: ['item-1'],
      itemCategoryById: {'item-1': 'category-1'}});
    expect(writes.order).to.containEql({isOnAccount: true, couponCode: 'ONCE'});
    expect((writes.order as {draftEditorState: {inspectionStarted: boolean; deliveryDateAnchor: string}})
      .draftEditorState.inspectionStarted).to.equal(true);
    expect(new Date((writes.order as {draftEditorState: {deliveryDateAnchor: string}})
      .draftEditorState.deliveryDateAnchor).getTime()).to.be.greaterThan(0);
    expect(result).to.containEql({totalAmount: 227});
    expect(steps).to.deepEqual(['lock coupon', 'evaluate', 'recalculate', 'commit']);
  });

  it('rolls back detail changes when repricing rejects the new total', async () => {
    let committed = false;
    let rolledBack = false;
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderRepo: {findOne: async () => ({id: 'draft-1', customerId: 'customer-1', storeId: 'store-1', status: OrderStatus.DRAFT}),
        updateById: async () => {}},
      customerRepo: {findById: async () => ({})},
      orderItemRepo: {find: async () => []},
      couponRedemptionRepo: {find: async () => []},
      orderChargeRepo: {deleteAll: async () => {}},
      resolveAdditionalChargePercentage: async () => 0,
      normalizeAdditionalCharges: () => [],
      dataSource: {execute: async () => {}, beginTransaction: async () => ({
        commit: async () => {committed = true;}, rollback: async () => {rolledBack = true;},
      })},
      recalculateOrderTotals: async () => {throw new Error('total below collected');},
    }) as OrderService;

    await expect(service.updateDraftDetails('draft-1', {
      additionalChargeIds: [], couponCodes: [], paymentIsOnAccount: false,
    })).to.be.rejectedWith('total below collected');
    expect(rolledBack).to.equal(true);
    expect(committed).to.equal(false);
  });

  it('auto-applies a referral when a draft moves to a new customer without an explicit code', async () => {
    const calls: string[] = [];
    const referral = {couponId: 'referral-1', code: 'REFERRED', discountType: 'percentage',
      discountAmount: 20, pricingSnapshot: {id: 'referral-1', code: 'REFERRED'}};
    let savedCoupon = '';
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderRepo: {findOne: async () => ({id: 'draft-1', customerId: 'customer-2',
        storeId: 'store-1', status: OrderStatus.DRAFT}),
        updateById: async (_id: string, fields: {couponCode: string}) => {savedCoupon = fields.couponCode;}},
      customerRepo: {findById: async () => ({id: 'customer-2', referredByCouponId: 'referral-1'})},
      orderItemRepo: {find: async () => [{serviceId: 'service-1', itemId: 'item-1',
        quantity: 1, totalPrice: 200}]},
      couponRedemptionRepo: {find: async () => [], create: async () => {calls.push('redeem');}},
      couponService: {
        evaluateReferralCoupon: async () => referral,
        evaluateNewCustomerCoupon: async () => {throw new Error('referral has priority');},
        evaluateMultiple: async (input: {allowReferralCouponCodes: string[]}) => {
          expect(input.allowReferralCouponCodes).to.containEql('REFERRED');
          calls.push('evaluate');
          return {valid: true, coupons: [referral]};
        },
      },
      lockCouponCodes: async (codes: string[]) => {expect(codes).to.containEql('REFERRED'); calls.push('lock');},
      orderChargeRepo: {deleteAll: async () => {}},
      couponRepo: {findById: async () => ({totalUsesCount: 0}), updateById: async () => {}},
      resolveAdditionalChargePercentage: async () => 0,
      normalizeAdditionalCharges: () => [],
      dataSource: {execute: async () => {}, beginTransaction: async () => ({
        commit: async () => {}, rollback: async () => {},
      })},
      recalculateOrderTotals: async () => ({}),
    }) as OrderService;

    await service.updateDraftDetails('draft-1', {
      additionalChargeIds: [], couponCodes: [], paymentIsOnAccount: false,
      autoApplyForChangedCustomer: true,
    });
    expect(savedCoupon).to.equal('REFERRED');
    expect(calls).to.deepEqual(['lock', 'evaluate', 'redeem']);
  });

  it('rolls back metadata when an item edit fails', async () => {
    let committed = false;
    let rolledBack = false;
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {execute: async () => {}, beginTransaction: async () => ({
        commit: async () => {committed = true;}, rollback: async () => {rolledBack = true;},
      })},
      orderRepo: {findOne: async () => ({status: OrderStatus.DRAFT}), updateById: async () => {}},
      customerRepo: {findOne: async () => ({id: 'customer-2'})},
      orderLabelAssignmentRepo: {deleteAll: async () => {}},
      updateOrderItems: async () => {throw new Error('invalid item');},
    }) as OrderService;

    await expect(service.saveDraftOrder('draft-1', {
      customerId: 'customer-2', orderType: OrderType.STORE_DROPOFF_HOME_DELIVERY,
      orderLabelIds: [], items: [],
      additionalChargeIds: [], couponCodes: [], paymentIsOnAccount: false,
    }, 'staff-1')).to.be.rejectedWith('invalid item');
    expect(rolledBack).to.equal(true);
    expect(committed).to.equal(false);
  });

  it('saves metadata, items and details in one transaction', async () => {
    const steps: string[] = [];
    let metadata: Record<string, unknown> = {};
    const transaction = {commit: async () => {steps.push('commit');}, rollback: async () => {steps.push('rollback');}};
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {execute: async (sql: string) => {steps.push(sql.includes('public.customer') ? 'customer lock' : 'lock');},
        beginTransaction: async () => transaction},
      orderRepo: {findOne: async () => ({status: OrderStatus.DRAFT, customerId: 'customer-1'}),
        updateById: async (_id: string, fields: Record<string, unknown>) => {metadata = fields; steps.push('metadata');}},
      customerRepo: {findOne: async () => ({id: 'customer-2'})},
      orderLabelAssignmentRepo: {deleteAll: async () => {steps.push('labels');}},
      updateOrderItems: async (_id: string, _items: unknown, _staff: string, options: {transaction: unknown}) => {
        expect(options.transaction).to.equal(transaction);
        steps.push('items');
      },
      updateDraftDetails: async (_id: string, input: {autoApplyForChangedCustomer?: boolean}, tx: unknown) => {
        expect(tx).to.equal(transaction);
        expect(input.autoApplyForChangedCustomer).to.equal(true);
        steps.push('details');
        return {totalAmount: 200};
      },
      statusHistoryRepo: {create: async () => {steps.push('history');}},
    }) as OrderService;

    const result = await service.saveDraftOrder('draft-1', {
      customerId: 'customer-2', orderType: OrderType.STORE_DROPOFF_HOME_DELIVERY,
      orderLabelIds: [], items: [],
      additionalChargeIds: [], couponCodes: [], paymentIsOnAccount: false,
    }, 'staff-1');
    expect(result).to.containEql({totalAmount: 200});
    expect(metadata).to.containEql({customerId: 'customer-2',
      orderType: OrderType.STORE_DROPOFF_HOME_DELIVERY,
      deliveryAddressId: null, deliveryAddress: ''});
    expect(steps).to.deepEqual(['lock', 'customer lock', 'metadata', 'labels', 'items', 'details', 'history', 'commit']);
  });

  it('moves a draft to the selected store before repricing its items', async () => {
    const steps: string[] = [];
    let metadata: Record<string, unknown> = {};
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {execute: async () => {}, beginTransaction: async () => ({
        commit: async () => {}, rollback: async () => {},
      })},
      orderRepo: {findOne: async () => ({status: OrderStatus.DRAFT, customerId: 'customer-1', storeId: 'old-store'}),
        updateById: async (_id: string, fields: Record<string, unknown>) => {metadata = fields; steps.push('metadata');}},
      customerRepo: {findOne: async () => ({id: 'customer-1'})},
      resolveNextOrderNumber: async () => 'NEW-1026-0001',
      lockStorePrefix: async (storeId: string) => {expect(storeId).to.equal('new-store'); steps.push('store lock');},
      orderLabelAssignmentRepo: {deleteAll: async () => {}},
      updateOrderItems: async () => {steps.push('items');},
      updateDraftDetails: async (_id: string, input: {autoApplyForChangedCustomer?: boolean}) => {
        expect(input.autoApplyForChangedCustomer).to.equal(true);
        steps.push('details');
        return {};
      },
      statusHistoryRepo: {create: async () => {}},
    }) as OrderService;

    await service.saveDraftOrder('draft-1', {
      customerId: 'customer-1', storeId: 'new-store', orderType: OrderType.STORE_DROPOFF,
      orderLabelIds: [], items: [], additionalChargeIds: [], couponCodes: [], paymentIsOnAccount: false,
    }, 'staff-1');
    expect(metadata).to.containEql({storeId: 'new-store', orderNumber: 'NEW-1026-0001'});
    expect(steps).to.deepEqual(['store lock', 'metadata', 'items', 'details']);
  });

  it('rejects On Account when a draft changes to an ineligible customer', async () => {
    let updated = false;
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {execute: async () => {}, beginTransaction: async () => ({
        commit: async () => {}, rollback: async () => {},
      })},
      orderRepo: {findOne: async () => ({status: OrderStatus.DRAFT, customerId: 'old-customer', storeId: 'store-1'}),
        updateById: async () => {updated = true;}},
      customerRepo: {findOne: async () => ({id: 'new-customer', customerEntityType: 'individual'})},
    }) as OrderService;

    await expect(service.saveDraftOrder('draft-1', {
      customerId: 'new-customer', storeId: 'store-1', orderType: OrderType.STORE_DROPOFF,
      orderLabelIds: [], items: [], additionalChargeIds: [], couponCodes: [], paymentIsOnAccount: true,
    }, 'staff-1')).to.be.rejectedWith(/not eligible for On Account/);
    expect(updated).to.equal(false);
  });

  it('accepts a linked family address but rejects an unrelated customer address', async () => {
    let linked = false;
    let saved = false;
    const controller = Object.assign(Object.create(OrderController.prototype), {
      storeScopeService: {assertOrderVisible: async () => {}},
      customerAddressRepository: {findOne: async () => ({customerId: 'parent-1'})},
      customerFamilyGroupRepository: {findOne: async ({where}: {where: {primaryCustomerId: string}}) => {
        expect(where.primaryCustomerId).to.equal('parent-1');
        return {id: 'group-1'};
      }},
      customerFamilyGroupMemberRepository: {findOne: async ({where}: {where: {customerId: string}}) => {
        expect(where.customerId).to.equal('child-1');
        return linked ? {id: 'member-1'} : null;
      }},
      customerAddressService: {toDisplaySnapshot: () => 'Parent address'},
      orderService: {saveDraftOrder: async () => {saved = true; return {}; }},
    }) as OrderController;
    const body = {customerId: 'child-1', deliveryAddressId: 'address-1'} as never;

    await expect(controller.saveDraftOrder({} as never, 'draft-1', body))
      .to.be.rejectedWith('Delivery address does not belong to this customer.');
    expect(saved).to.equal(false);
    linked = true;
    await controller.saveDraftOrder({} as never, 'draft-1', body);
    expect(saved).to.equal(true);
  });

  it('rejects moving a draft to a store outside the caller scope', async () => {
    let saved = false;
    const controller = Object.assign(Object.create(OrderController.prototype), {
      storeScopeService: {assertOrderVisible: async () => {},
        resolve: async () => ({global: false, storeIds: ['store-1']}),
        allows: (scope: {storeIds: string[]}, storeId: string) => scope.storeIds.includes(storeId)},
      orderService: {saveDraftOrder: async () => {saved = true; return {}; }},
    }) as OrderController;
    const body = {customerId: 'customer-1', storeId: 'store-2'} as never;
    await expect(controller.saveDraftOrder({} as never, 'draft-1', body))
      .to.be.rejectedWith('Store not found.');
    expect(saved).to.equal(false);
  });
  it('checks the caller store before creating, changing status or collecting payment', async () => {
    const calls: string[] = [];
    const controller = Object.assign(Object.create(OrderController.prototype), {
      storeScopeService: {resolve: async () => ({storeIds: ['store-1']}),
        allows: (_scope: object, id: string) => id === 'store-1',
        assertOrderVisible: async () => {throw new Error('outside store scope');}},
      orderService: {createOrder: async () => {calls.push('create');},
        changeStatus: async () => {calls.push('status');},
        addPayment: async () => {calls.push('payment');}},
    }) as OrderController;
    await expect(controller.createOrder({} as never, {storeId: 'store-2'} as never))
      .to.be.rejectedWith('Store not found.');
    await expect(controller.changeStatus({} as never, 'order-2', {status: OrderStatus.CONFIRMED}))
      .to.be.rejectedWith('outside store scope');
    await expect(controller.addPayment({} as never, 'order-2', {walletAmount: 1}))
      .to.be.rejectedWith('outside store scope');
    expect(calls).to.deepEqual([]);
  });
  it('blocks draft payment and garment processing at the API service boundaries', async () => {
    const orderService = Object.assign(Object.create(OrderService.prototype), {
      orderRepo: {findOne: async () => ({status: OrderStatus.DRAFT})},
    }) as OrderService;
    await expect(orderService.addPayment('draft-1', {} as never, 1, 'staff-1'))
      .to.be.rejectedWith('Drafts cannot collect payment.');
    const scopeService = Object.assign(Object.create(StoreScopeService.prototype), {
      resolve: async () => ({global: true}),
      garmentRepo: {findOne: async () => ({orderItemId: 'item-1'})},
      orderItemRepo: {findOne: async () => ({orderId: 'draft-1'})},
      orderRepo: {findOne: async () => ({status: OrderStatus.DRAFT})},
    }) as StoreScopeService;
    await expect(scopeService.assertGarmentEditable('garment-1', {} as never))
      .to.be.rejectedWith('Submit the draft before processing its garments.');
  });
});
