import {BindingScope, inject, injectable} from '@loopback/core';
import {DataObject, Options, repository} from '@loopback/repository';
import {PaymentTransaction} from '../models';
import {PaymentTransactionRepository} from '../repositories';
import {dispatchWhatsApp, WhatsAppService} from './whatsapp.service';

/** Payment writes and post-commit receipt notifications are explicit operations. */
@injectable({scope: BindingScope.TRANSIENT})
export class PaymentService {
  constructor(
    @repository(PaymentTransactionRepository)
    private paymentRepository: PaymentTransactionRepository,
    @inject('services.whatsapp') private whatsAppService: WhatsAppService,
  ) {}

  async recordPayment(
    data: DataObject<PaymentTransaction>,
    options?: Options,
  ): Promise<PaymentTransaction> {
    return this.paymentRepository.create(data, options);
  }

  /** The transaction owner calls this only after commit succeeds. */
  notifyPaymentReceived(payment: PaymentTransaction): void {
    if (payment.transactionType !== 'refund' && Number(payment.amount) > 0) {
      dispatchWhatsApp(() => this.whatsAppService.notifyPayment(payment));
    }
  }
}
