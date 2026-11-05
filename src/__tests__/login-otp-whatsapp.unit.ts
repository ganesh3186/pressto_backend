/* eslint-disable @typescript-eslint/no-explicit-any -- Service doubles avoid all external sends. */
import {expect, sinon} from '@loopback/testlab';
import axios from 'axios';
import {OtpService} from '../services/otp.service';
import {WhatsAppService} from '../services/whatsapp.service';

describe('login codes with WhatsApp notifications off', () => {
  const FLAGS = ['WHATSAPP_ENABLED', 'WHATSAPP_ACCESS_TOKEN'] as const;
  const previous: Record<string, string | undefined> = {};
  let post: sinon.SinonStub;

  beforeEach(() => {
    for (const flag of FLAGS) previous[flag] = process.env[flag];
    process.env.WHATSAPP_ENABLED = 'false';
    process.env.WHATSAPP_ACCESS_TOKEN = 'test-token';
    post = sinon.stub(axios, 'post').resolves({status: 200, data: {id: 'message-1'}} as any);
  });

  afterEach(() => {
    sinon.restore();
    for (const flag of FLAGS) {
      if (previous[flag] === undefined) delete process.env[flag];
      else process.env[flag] = previous[flag];
    }
  });

  function whatsApp() {
    return Object.assign(Object.create(WhatsAppService.prototype), {
      warned: new Set<string>(),
      sent: new Map(),
      pending: new Map(),
    }) as WhatsAppService;
  }

  function otpService(whatsAppService: unknown) {
    const saved: any[] = [];
    const service = Object.assign(Object.create(OtpService.prototype), {
      usersRepository: {updateById: async (_id: string, data: object) => saved.push(data)},
      hasher: {hashPassword: async () => 'hashed-code'},
      whatsAppService,
    }) as OtpService;
    return {service, saved};
  }

  const user = {id: 'user-1', phone: '9999999999', countryCode: '+91'};

  it('sends the code on WhatsApp and leaves it out of the response', async () => {
    const {service, saved} = otpService(whatsApp());

    const result = await service.sendLoginOtp(user);

    expect(result).to.eql({message: 'Login code requested on WhatsApp', expiresInSeconds: 600});
    expect(post.calledOnce).to.equal(true);
    const body = post.firstCall.args[1];
    expect(body.template.name).to.equal('pulse_login_otp_221026');
    expect(body.template.components[0].parameters[0].text).to.match(/^\d{6}$/);
    expect(saved[0].loginOtp).to.equal('hashed-code');
  });

  it('refuses the request rather than returning the code when the send fails', async () => {
    post.resolves({status: 500, data: {}});
    const {service} = otpService(whatsApp());

    let error: any;
    try {
      await service.sendLoginOtp(user);
    } catch (e) {
      error = e;
    }

    expect(error?.statusCode).to.equal(503);
    expect(JSON.stringify(error)).not.to.match(/\b\d{6}\b/);
  });

  it('does not send the code without a provider token', async () => {
    delete process.env.WHATSAPP_ACCESS_TOKEN;

    const accepted = await whatsApp().sendTemplateMessage({
      to: '919999999999',
      templateId: 'pulse_login_otp_221026',
      bodyParams: ['123456'],
    });

    expect(accepted).to.equal(false);
    expect(post.called).to.equal(false);
  });

  it('keeps blocking notifications', async () => {
    const service = whatsApp();

    const direct = await service.sendTemplateMessage({
      to: '919999999999',
      templateId: 'pulse_wallet_recharge_221026',
      bodyParams: ['Customer', '100', '200', 'TXN-1'],
    });
    const queued = await service.notifyWalletRecharge({
      customerId: 'customer-1',
      amount: 100,
      balance: 200,
      transactionId: 'TXN-1',
    } as any);

    expect(direct).to.equal(false);
    expect(queued).to.equal(false);
    expect(post.called).to.equal(false);
  });

  it('sends notifications again once the flag is on', async () => {
    process.env.WHATSAPP_ENABLED = 'true';

    const accepted = await whatsApp().sendTemplateMessage({
      to: '919999999999',
      templateId: 'pulse_wallet_recharge_221026',
      bodyParams: ['Customer', '100', '200', 'TXN-1'],
    });

    expect(accepted).to.equal(true);
    expect(post.calledOnce).to.equal(true);
  });
});
