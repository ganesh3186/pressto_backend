/* eslint-disable @typescript-eslint/no-explicit-any -- Service doubles avoid all external sends. */
import {expect} from '@loopback/testlab';
import {WhatsAppService} from '../services/whatsapp.service';

describe('delivery payment-link notification flag', () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.WHATSAPP_DELIVERY_PAYMENT_LINK_ENABLED;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.WHATSAPP_DELIVERY_PAYMENT_LINK_ENABLED;
    else process.env.WHATSAPP_DELIVERY_PAYMENT_LINK_ENABLED = previous;
  });

  function setup(due: number) {
    const sent: any[] = [];
    let documents = 0;
    let links = 0;
    const date = '2026-11-01T10:00:00Z';
    const service = Object.assign(Object.create(WhatsAppService.prototype), {
      configured: () => true,
      attachmentsEnabled: () => true,
      getDeliveries: async () => ({findOne: async () => ({
        id: 'run', status: 'assigned', riderId: 'rider', riderName: 'Test Rider',
        deliveryDate: date, deliverySlot: '14:00 - 15:00', assignedBy: 'staff',
      })}),
      getDeliveryOrders: async () => ({find: async () => [{orderId: 'order', status: 'pending'}]}),
      getOrders: async () => ({findOne: async () => ({
        id: 'order', customerId: 'customer', orderNumber: 'TEST-0001', status: 'ready',
        assignedRiderId: 'rider', deliveryMethod: 'home_delivery',
        deliveryDate: date, deliverySlot: '14:00 - 15:00',
      })}),
      customer: async () => ({name: 'Test Customer', to: '919999999999'}),
      getOrderService: async () => ({computeBalanceDue: async () => ({due})}),
      invoice: async () => ({id: 'invoice', invoiceNumber: 'TEST-INVOICE'}),
      invoiceDocument: async () => {
        documents++;
        return {type: 'document', url: 'https://example.com/invoice.pdf'};
      },
      getRazorpayService: async () => ({createPaymentLink: async () => {
        links++;
        return {shortUrl: 'https://example.com/pay', expiresAt: new Date(Date.now() + 3600000),
          status: 'created', referenceId: 'order', referenceType: 'order_payment', amount: due};
      }}),
      once: async (_key: string, prepare: () => Promise<any>) => {
        const message = await prepare();
        if (message) sent.push(message);
      },
    }) as WhatsAppService;
    return {service, sent, documents: () => documents, links: () => links};
  }

  it('skips the unpaid message, document and payment link when disabled', async () => {
    process.env.WHATSAPP_DELIVERY_PAYMENT_LINK_ENABLED = 'false';
    const test = setup(500);
    await test.service.notifyDeliveryAssigned('run');
    expect(test.sent).to.have.length(0);
    expect(test.documents()).to.equal(0);
    expect(test.links()).to.equal(0);
  });

  it('keeps paid rider-details messages enabled when the payment-link flag is false', async () => {
    process.env.WHATSAPP_DELIVERY_PAYMENT_LINK_ENABLED = 'false';
    const test = setup(0);
    await test.service.notifyDeliveryAssigned('run');
    expect(test.sent).to.have.length(1);
    expect(test.sent[0].templateId).to.equal('pulse_ready_to_deliver_with_rider_details_221026');
    expect(test.documents()).to.equal(1);
    expect(test.links()).to.equal(0);
  });

  it('preserves unpaid assignment notifications when enabled or unset', async () => {
    for (const flag of ['true', undefined]) {
      if (flag === undefined) delete process.env.WHATSAPP_DELIVERY_PAYMENT_LINK_ENABLED;
      else process.env.WHATSAPP_DELIVERY_PAYMENT_LINK_ENABLED = flag;
      const test = setup(500);
      await test.service.notifyDeliveryAssigned('run');
      expect(test.sent).to.have.length(1);
      expect(test.sent[0].templateId).to.equal('pulse_ready_to_deliver_with_rider_details_with_paymentlink_221026');
      expect(test.links()).to.equal(1);
    }
  });

  it('also blocks direct sends of the unpaid assignment template', async () => {
    process.env.WHATSAPP_DELIVERY_PAYMENT_LINK_ENABLED = 'false';
    const service = Object.create(WhatsAppService.prototype) as WhatsAppService;
    expect(await service.sendTemplateMessage({
      to: '919999999999',
      templateId: 'pulse_ready_to_deliver_with_rider_details_with_paymentlink_221026',
      bodyParams: [],
    })).to.equal(false);
  });
});
