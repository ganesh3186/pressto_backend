import {BindingScope, inject, injectable} from '@loopback/core';
import {DataObject, Options, repository} from '@loopback/repository';
import {PaymentTransaction} from '../models';
import {PaymentTransactionRepository} from '../repositories';
import {afterWhatsAppCommit, WhatsAppService} from './whatsapp.service';

/** Records a collected payment and schedules its customer receipt after commit. */
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
    const payment = await this.paymentRepository.create(data, options);
    if (payment.transactionType !== 'refund' && Number(payment.amount) > 0) {
      afterWhatsAppCommit(options, () =>
        this.whatsAppService.notifyPayment(payment),
      );
    }
    return payment;
  }
}
