import {Client, createRestAppClient, expect, givenHttpServerConfig} from '@loopback/testlab';
import {presstoBackendApplication} from '../..';

describe('Rate limit on a running app', () => {
  let app: presstoBackendApplication;
  let client: Client;

  before(async () => {
    app = new presstoBackendApplication({
      rest: givenHttpServerConfig(),
      rateLimit: {
        mode: 'enforce',
        limits: {auth: 1, files: 1, user: 1, anonymous: 2},
        workers: 1,
      },
    });
    await app.boot();
    await app.start();
    client = createRestAppClient(app);
  });

  after(async () => {
    await app.stop();
  });

  it('answers 429 through the normal error format, and keeps /ping open', async () => {
    await client.get('/not-a-route').expect(404);
    await client.get('/not-a-route').expect(404);

    const blocked = await client.get('/not-a-route').expect(429);
    expect(blocked.body.error.statusCode).to.equal(429);
    expect(Number(blocked.headers['retry-after'])).to.be.within(1, 60);

    await client.get('/ping').expect(200);
  });

  it('limits login separately', async () => {
    await client.post('/auth/login').send({}).expect(res => {
      expect(res.status).to.not.equal(429);
    });
    await client.post('/auth/login').send({}).expect(429);
  });
});
