import {Client, expect} from '@loopback/testlab';
import {presstoBackendApplication} from '../..';
import {setupApplication} from './test-helper';

describe('Rider delivery payment QR endpoint', () => {
  let app: presstoBackendApplication;
  let client: Client;

  before('setupApplication', async () => {
    ({app, client} = await setupApplication());
  });

  after(async () => {
    await app.stop();
  });

  it('registers the payment QR route and requires rider authentication', async () => {
    const response = await client
      .post('/rider/deliveries/review-smoke/orders/review-smoke/payment-qr')
      .expect(401);

    expect(response.body.error).to.have.property('message');
  });
});
