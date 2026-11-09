import {expect} from '@loopback/testlab';
import {securityId, UserProfile} from '@loopback/security';
import {CustomerOrderController} from '../controllers/customer-order.controller';
import {InvoiceController} from '../controllers/invoice.controller';
import {Challan} from '../models/challan.model';
import {Order} from '../models/order.model';
import {OrderService} from '../services/order.service';

describe('invoice discount sync', () => {
  it('serves a customer the invoice refreshed from saved order totals', async () => {
    const invoice = {
      id: 'invoice-1', subtotal: 192, discount: 0,
      cgst: 17.28, sgst: 17.28, totalAmount: 227,
    };
    const controller = Object.assign(Object.create(CustomerOrderController.prototype), {
      customerRepo: {findOne: async () => ({id: 'customer-1'})},
      orderRepo: {findOne: async () => ({id: 'order-1', customerId: 'customer-1'})},
      invoiceRepo: {
        findOne: async () => invoice,
      },
      orderService: {
        syncInvoiceTotalsForOrder: async () => ({
          ...invoice, discount: 19.2, cgst: 15.55, sgst: 15.55, totalAmount: 204,
        }),
      },
    }) as CustomerOrderController;

    const result = await controller.myOrderInvoice(
      {[securityId]: 'user-1'} as UserProfile, 'order-1',
    );

    expect(result).to.containEql({invoice: {
      id: 'invoice-1', subtotal: 192, discount: 19.2,
      cgst: 15.55, sgst: 15.55, totalAmount: 204,
    }});
  });

  it('syncs customer invoice totals from the order when there is no challan', async () => {
    const order = {id: 'order-1', customerId: 'customer-1'};
    const invoice = {id: 'invoice-1', discount: 19.2, totalAmount: 204};
    const controller = Object.assign(Object.create(CustomerOrderController.prototype), {
      customerRepo: {findOne: async () => ({id: 'customer-1'})},
      orderRepo: {findOne: async () => order},
      invoiceRepo: {findOne: async () => ({id: 'invoice-1', discount: 0, totalAmount: 227})},
      orderService: {syncInvoiceTotalsForOrder: async (ownedOrder: Order) => {
        expect(ownedOrder).to.equal(order);
        return invoice;
      }},
    }) as CustomerOrderController;

    const result = await controller.myOrderInvoice(
      {[securityId]: 'user-1'} as UserProfile, 'order-1',
    );

    expect(result).to.containEql({invoice});
  });

  it('keeps a saved invoice when legacy order totals are missing or zeroed', async () => {
    let savedPatch: Record<string, number> | undefined;
    const invoice = {
      id: 'invoice-1',
      subtotal: 192,
      discount: 0,
      cgst: 17.28,
      sgst: 17.28,
      totalAmount: 227,
    };
    const order = {
      id: 'order-1',
      status: 'ready',
      subtotal: null,
      discountAmount: null,
      taxAmount: null,
      totalAmount: null,
    };
    const service = Object.assign(Object.create(OrderService.prototype), {
      salesReturnRepo: {find: async () => []},
      dataSource: {
        beginTransaction: async () => ({
          commit: async () => {},
          rollback: async () => {},
        }),
        execute: async () => {},
      },
      orderRepo: {findOne: async () => order},
      computeBalanceDue: async () => ({alreadyPaid: 0, due: 0}),
      invoiceRepo: {
        findOne: async () => invoice,
        updateById: async (_id: string, patch: Record<string, number>) => {
          savedPatch = patch;
        },
        findById: async () => ({...invoice, ...savedPatch}),
      },
    }) as OrderService;

    expect(
      await service.syncInvoiceTotalsForOrder(order as unknown as Order),
    ).to.equal(invoice);
    expect(savedPatch).to.equal(undefined);
    await service.generateInvoiceForOrder('order-1', 'staff-1');
    expect(savedPatch).to.containEql({amountReceived: 0, balanceDue: 227});
    expect(savedPatch).not.to.have.property('subtotal');
    savedPatch = undefined;

    Object.assign(order, {
      subtotal: 0,
      discountAmount: 0,
      taxAmount: 0,
      totalAmount: 0,
    });
    expect(
      await service.syncInvoiceTotalsForOrder(order as unknown as Order),
    ).to.equal(invoice);
    expect(savedPatch).to.equal(undefined);
    await service.generateInvoiceForOrder('order-1', 'staff-1');
    expect(savedPatch).to.containEql({amountReceived: 0, balanceDue: 227});
    expect(savedPatch).not.to.have.property('subtotal');
  });

  it('saves the corrected invoice when a challan refresh changes the order discount', async () => {
    let savedInvoice: Record<string, number> | undefined;
    const order = {
      id: 'order-1',
      customerId: 'customer-1',
      subtotal: 192,
      discountAmount: 0,
      taxAmount: 34.56,
      totalAmount: 227,
    };
    const challan = {
      id: 'challan-1',
      items: [],
      subtotal: 192,
      discount: 0,
      cgst: 17.28,
      sgst: 17.28,
      totalAmount: 227,
    };
    const service = Object.assign(Object.create(OrderService.prototype), {
      salesReturnRepo: {find: async () => []},
      dataSource: {
        beginTransaction: async () => ({
          commit: async () => {},
          rollback: async () => {},
        }),
        execute: async () => {},
      },
      orderRepo: {
        findOne: async () => order,
        findById: async () => order,
        updateById: async (_id: string, patch: Partial<typeof order>) => {
          Object.assign(order, patch);
        },
      },
      challanRepo: {
        findOne: async () => challan,
        findById: async () => challan,
        updateById: async () => {},
      },
      orderItemRepo: {
        find: async () => [
          {
            id: 'shirt-1',
            itemId: 'shirt',
            quantity: 1,
            unitPrice: 192,
            totalPrice: 192,
          },
        ],
      },
      garmentRepo: {find: async () => []},
      orderItemChargeRepo: {find: async () => []},
      orderChargeRepo: {find: async () => []},
      itemRepo: {find: async () => [{id: 'shirt'}]},
      customerRepo: {findById: async () => ({id: 'customer-1'})},
      gstConfigRepo: {
        findOne: async () => ({cgstPercentage: 9, sgstPercentage: 9}),
      },
      resolveCustomerAutoDiscount: async () => ({
        discountAmount: 19.2,
        discountType: 'percentage',
      }),
      computeBalanceDue: async () => ({alreadyPaid: 204, due: 0}),
      invoiceRepo: {
        findOne: async () => ({
          id: 'invoice-1',
          subtotal: 192,
          discount: 0,
          cgst: 17.28,
          sgst: 17.28,
          totalAmount: 227,
        }),
        updateById: async (_id: string, patch: Record<string, number>) => {
          savedInvoice = patch;
        },
      },
    }) as OrderService;

    await service.syncChallanTotalsForOrder(
      'order-1',
      challan as unknown as Challan,
    );

    expect(savedInvoice).to.containEql({
      subtotal: 192,
      discount: 19.2,
      cgst: 15.55,
      sgst: 15.55,
      totalAmount: 204,
      amountReceived: 204,
      balanceDue: 0,
    });
  });

  it('does not reprice a paid order when the customer discount changes', async () => {
    for (const alreadyPaid of [220, 227]) {
      const order = {
        id: 'order-1', customerId: 'customer-1', subtotal: 192,
        discountAmount: 0, taxAmount: 34.56, totalAmount: 227,
      };
      const challan = {
        id: 'challan-1', items: [], subtotal: 192,
        discount: 0, cgst: 17.28, sgst: 17.28, totalAmount: 227,
      };
      let orderUpdated = false;
      let invoiceUpdated = false;
      const service = Object.assign(Object.create(OrderService.prototype), {
        salesReturnRepo: {find: async () => []},
        dataSource: {
          beginTransaction: async () => ({commit: async () => {}, rollback: async () => {}}),
          execute: async () => {},
        },
        orderRepo: {
          findOne: async () => order,
          updateById: async () => { orderUpdated = true; },
        },
        challanRepo: {findById: async () => challan, updateById: async () => {}},
        orderItemRepo: {find: async () => []},
        garmentRepo: {find: async () => []},
        orderItemChargeRepo: {find: async () => []},
        orderChargeRepo: {find: async () => []},
        customerRepo: {findById: async () => ({id: 'customer-1'})},
        gstConfigRepo: {findOne: async () => ({cgstPercentage: 9, sgstPercentage: 9})},
        resolveCustomerAutoDiscount: async () => ({discountAmount: 19.2, discountType: 'percentage'}),
        computeBalanceDue: async () => ({alreadyPaid, due: Math.max(0, 227 - alreadyPaid)}),
        invoiceRepo: {
          findOne: async () => ({
            id: 'invoice-1', subtotal: 192, discount: 0,
            cgst: 17.28, sgst: 17.28, totalAmount: 227,
          }),
          updateById: async () => { invoiceUpdated = true; },
        },
      }) as OrderService;

      await service.syncChallanTotalsForOrder('order-1', challan as unknown as Challan);

      expect(orderUpdated).to.equal(false);
      expect(invoiceUpdated).to.equal(false);
      expect(challan).to.containEql({subtotal: 192, discount: 0, totalAmount: 227});
    }
  });

  it('updates an existing invoice after a payment changes the order discount', async () => {
    let savedInvoice: Record<string, number> | undefined;
    const invoice = {
      id: 'invoice-1',
      subtotal: 192,
      discount: 0,
      cgst: 17.28,
      sgst: 17.28,
      totalAmount: 227,
    };
    const service = Object.assign(Object.create(OrderService.prototype), {
      salesReturnRepo: {find: async () => []},
      dataSource: {
        beginTransaction: async () => ({
          commit: async () => {},
          rollback: async () => {},
        }),
        execute: async () => {},
      },
      orderRepo: {
        findOne: async () => ({
          id: 'order-1',
          status: 'ready',
          subtotal: 192,
          discountAmount: 19.2,
          taxAmount: 31.1,
          totalAmount: 204,
        }),
      },
      computeBalanceDue: async () => ({alreadyPaid: 204, due: 0}),
      invoiceRepo: {
        findOne: async () => invoice,
        updateById: async (_id: string, patch: Record<string, number>) => {
          savedInvoice = patch;
        },
        findById: async () => ({...invoice, ...savedInvoice}),
      },
    }) as OrderService;

    await service.generateInvoiceForOrder('order-1', 'staff-1');

    expect(savedInvoice).to.containEql({
      subtotal: 192,
      discount: 19.2,
      cgst: 15.55,
      sgst: 15.55,
      totalAmount: 204,
      amountReceived: 204,
      balanceDue: 0,
    });
  });

  it('repairs an older invoice without item snapshots on a direct invoice read', async () => {
    const order = {
      id: 'order-1',
      subtotal: 192,
      discountAmount: 19.2,
      taxAmount: 31.1,
      totalAmount: 204,
    };
    const invoice = {
      id: 'invoice-1',
      subtotal: 192,
      discount: 0,
      cgst: 17.28,
      sgst: 17.28,
      totalAmount: 227,
      items: undefined,
    };
    const service = Object.assign(Object.create(OrderService.prototype), {
      salesReturnRepo: {find: async () => []},
      dataSource: {
        beginTransaction: async () => ({
          commit: async () => {},
          rollback: async () => {},
        }),
        execute: async () => {},
      },
      orderRepo: {findById: async () => order},
      invoiceRepo: {
        findOne: async () => invoice,
        updateById: async () => {},
      },
      computeBalanceDue: async () => ({alreadyPaid: 204, due: 0}),
    }) as OrderService;
    const controller = Object.assign(
      Object.create(InvoiceController.prototype),
      {
        storeScopeService: {assertOrderVisible: async () => {}},
        orderRepo: {findOne: async () => order},
        salesReturnRepo: {find: async () => []},
        orderService: service,
      },
    ) as InvoiceController;

    const result = (await controller.getByOrder('order-1')) as {
      invoice: Record<string, number>;
    };

    expect(result.invoice).to.containEql({
      discount: 19.2,
      cgst: 15.55,
      sgst: 15.55,
      totalAmount: 204,
      balanceDue: 0,
    });
  });

  it('keeps an issued invoice\'s totals after a credit note, syncing only the balance', async () => {
    // Invoice issued at 824 + GST = 972; an add-on (402) was then credited
    // back, so the order itself dropped to 422 + GST = 498.
    const order = {
      id: 'order-1',
      subtotal: 422,
      discountAmount: 0,
      taxAmount: 75.96,
      totalAmount: 498,
    };
    const invoice: Record<string, unknown> = {
      id: 'invoice-1',
      subtotal: 824,
      discount: 0,
      cgst: 74.16,
      sgst: 74.16,
      totalAmount: 972,
      amountReceived: 0,
      balanceDue: 972,
    };
    const updates: Array<Record<string, unknown>> = [];
    const service = Object.assign(Object.create(OrderService.prototype), {
      salesReturnRepo: {
        find: async () => [{id: 'cn-1', returnedItems: [{serviceName: 'Alter Large', preservesInvoice: true}]}],
      },
      invoiceRepo: {
        findOne: async () => invoice,
        updateById: async (_id: string, patch: Record<string, unknown>) => {
          updates.push(patch);
        },
      },
      computeBalanceDue: async () => ({alreadyPaid: 0, due: 498}),
    }) as OrderService;

    const result = (await service.syncInvoiceTotalsForOrder(order as never, {})) as unknown as Record<string, unknown>;

    expect(result).to.containEql({subtotal: 824, totalAmount: 972, balanceDue: 498});
    expect(updates).to.have.length(1);
    expect(Object.keys(updates[0]).sort()).to.deepEqual(['amountReceived', 'balanceDue', 'updatedAt']);
  });

  it('locks the order before syncing a credited invoice\'s balance on a plain read', async () => {
    const order = {id: 'order-1', subtotal: 422, discountAmount: 0, taxAmount: 75.96, totalAmount: 498};
    const invoice: Record<string, unknown> = {
      id: 'invoice-1', subtotal: 824, discount: 0, cgst: 74.16, sgst: 74.16,
      totalAmount: 972, amountReceived: 0, balanceDue: 972,
    };
    const calls: string[] = [];
    const tx = {commit: async () => { calls.push('commit'); }, rollback: async () => { calls.push('rollback'); }};
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {
        beginTransaction: async () => { calls.push('begin'); return tx; },
        execute: async (sql: string) => { calls.push(sql.includes('FOR UPDATE') ? 'lock' : sql); },
      },
      orderRepo: {findById: async () => order},
      salesReturnRepo: {find: async () => [{id: 'cn-1', returnedItems: [{preservesInvoice: true}]}]},
      invoiceRepo: {
        findOne: async () => invoice,
        updateById: async (_id: string, _patch: object, options?: {transaction?: unknown}) => {
          calls.push(options?.transaction === tx ? 'update-in-tx' : 'update-outside-tx');
        },
      },
      computeBalanceDue: async () => ({alreadyPaid: 0, due: 498}),
    }) as OrderService;

    await service.syncInvoiceTotalsForOrder(order as never);

    expect(calls).to.deepEqual(['begin', 'lock', 'update-in-tx', 'commit']);
  });
});
