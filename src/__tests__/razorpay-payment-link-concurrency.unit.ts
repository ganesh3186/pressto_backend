import {expect} from '@loopback/testlab';
import {GatewayPaymentLink} from '../models/gateway-payment-link.model';
import {GatewayPaymentReferenceType} from '../models/gateway-payment-reference-type.enum';
import {RazorpayService} from '../services/razorpay.service';

describe('Razorpay payment-link creation concurrency', () => {
  it('reuses one active link when requests for the same order race', async () => {
    let lockTail = Promise.resolve();
    const releaseByTransaction = new Map<object, () => void>();
    const rows: GatewayPaymentLink[] = [];
    const lockQueries: string[] = [];
    let razorpayCreateCount = 0;

    const service = Object.create(RazorpayService.prototype) as RazorpayService;
    Object.assign(service, {
      dataSource: {
        beginTransaction: async () => {
          const transaction = {
            commit: async () => releaseByTransaction.get(transaction)?.(),
            rollback: async () => releaseByTransaction.get(transaction)?.(),
          };
          return transaction;
        },
        execute: async (
          sql: string,
          _parameters: unknown[],
          options: {transaction: object},
        ) => {
          lockQueries.push(sql);
          const previous = lockTail;
          let release!: () => void;
          lockTail = new Promise<void>(resolve => {
            release = resolve;
          });
          await previous;
          releaseByTransaction.set(options.transaction, release);
        },
      },
      gatewayPaymentLinkRepo: {
        findOne: async () => null,
        find: async () => rows,
        create: async (data: GatewayPaymentLink) => {
          const row = new GatewayPaymentLink(data);
          rows.push(row);
          return row;
        },
      },
      orderRepo: {
        findById: async () => ({
          id: 'order-1',
          totalAmount: 450,
        }),
      },
      orderService: {
        computeBalanceDue: async () => ({due: 450}),
      },
    });
    Object.defineProperty(service, 'client', {
      value: {
        paymentLink: {
          create: async () => {
            razorpayCreateCount++;
            return {
              id: 'rzp-link-1',
              /* eslint-disable @typescript-eslint/naming-convention */
              short_url: 'https://rzp.io/i/one-link',
              /* eslint-enable @typescript-eslint/naming-convention */
            };
          },
          cancel: async () => undefined,
        },
      },
    });

    const input = {
      referenceType: GatewayPaymentReferenceType.ORDER_PAYMENT,
      referenceId: 'order-1',
      amount: 450,
      description: 'Delivery payment for order ORD-1',
      customer: {name: 'Test Customer'},
    };
    const [first, second] = await Promise.all([
      service.createPaymentLink(input),
      service.createPaymentLink(input),
    ]);

    expect(razorpayCreateCount).to.equal(1);
    expect(rows).to.have.length(1);
    expect(first.id).to.equal(second.id);
    expect(first.shortUrl).to.equal(second.shortUrl);
    expect(lockQueries).to.have.length(2);
    expect(lockQueries[0]).to.match(/pg_advisory_xact_lock/);
  });
});
