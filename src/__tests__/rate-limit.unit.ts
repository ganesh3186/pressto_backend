import {expect} from '@loopback/testlab';
import {Request} from '@loopback/rest';
import * as jwt from 'jsonwebtoken';
import {
  classifyRequest,
  clientIpKey,
  createRateLimitMiddleware,
  FixedWindowCounter,
  RateLimitConfig,
  rateLimitConfigFromEnv,
} from '../middleware/rate-limit.middleware';

const SECRET = 'test-secret';
const request = (method: string, path: string, token?: string, ip = '10.0.0.1') =>
  ({
    method,
    path,
    ip,
    headers: token ? {authorization: `Bearer ${token}`} : {},
  }) as unknown as Request;

describe('rate limit middleware', () => {
  describe('classifyRequest', () => {
    const userToken = jwt.sign({id: 'user-a'}, SECRET);

    it('never limits preflights, health checks or payment webhooks', () => {
      expect(classifyRequest(request('OPTIONS', '/orders'), SECRET)).to.be.null();
      expect(classifyRequest(request('GET', '/ping'), SECRET)).to.be.null();
      expect(classifyRequest(request('POST', '/webhooks/razorpay'), SECRET)).to.be.null();
    });

    it('counts a valid token by user, wherever it comes from', () => {
      const fromOneIp = classifyRequest(request('GET', '/orders', userToken, '10.0.0.1'), SECRET);
      const fromAnother = classifyRequest(request('GET', '/stores', userToken, '10.0.0.2'), SECRET);
      expect(fromOneIp).to.eql({tier: 'user', key: 'user:user-a'});
      expect(fromAnother).to.eql(fromOneIp);
    });

    it('counts a forged, expired or id-less token by IP', () => {
      const tokens = [
        jwt.sign({id: 'user-a'}, 'wrong-secret'),
        jwt.sign({id: 'user-a'}, SECRET, {expiresIn: -10}),
        jwt.sign({email: 'a@b.c'}, SECRET),
        'not-a-token',
      ];
      for (const token of tokens) {
        expect(classifyRequest(request('GET', '/orders', token), SECRET)).to.eql({
          tier: 'anonymous',
          key: 'anonymous:10.0.0.1',
        });
      }
    });

    it('counts login and OTP by IP, even with a token', () => {
      for (const path of ['/auth/login', '/auth/customer/send-otp', '/auth/rider/verify-otp']) {
        expect(classifyRequest(request('POST', path, userToken), SECRET)).to.eql({
          tier: 'auth',
          key: 'auth:10.0.0.1',
        });
      }
    });

    it('leaves GET /auth/me in the user tier and gives public images their own', () => {
      expect(classifyRequest(request('GET', '/auth/me', userToken), SECRET)?.tier).to.equal('user');
      expect(classifyRequest(request('GET', '/files/file/a.png'), SECRET)?.tier).to.equal('files');
    });
  });

  describe('clientIpKey', () => {
    it('normalizes IPv4-mapped addresses and groups IPv6 by /64', () => {
      expect(clientIpKey('::ffff:10.0.0.1')).to.equal('10.0.0.1');
      expect(clientIpKey('2001:db8:1:2:3:4:5:6')).to.equal('2001:db8:1:2');
      expect(clientIpKey('2001:db8:1:2:9:9:9:9')).to.equal('2001:db8:1:2');
      expect(clientIpKey(undefined)).to.equal('unknown');
    });
  });

  describe('FixedWindowCounter', () => {
    it('resets when the window ends and forgets finished windows', () => {
      let time = 0;
      const counter = new FixedWindowCounter(1000, () => time);
      counter.hit('a');
      expect(counter.hit('a').count).to.equal(2);
      time = 1000;
      expect(counter.hit('a').count).to.equal(1);
      counter.hit('b');
      time = 2500;
      counter.hit('c');
      expect(counter.size).to.equal(1);
    });
  });

  describe('config', () => {
    it('stays report-only unless enforcement is asked for', () => {
      expect(rateLimitConfigFromEnv({}).mode).to.equal('report');
      expect(rateLimitConfigFromEnv({RATE_LIMIT_MODE: 'typo'}).mode).to.equal('report');
      expect(rateLimitConfigFromEnv({RATE_LIMIT_MODE: 'enforce'}).mode).to.equal('enforce');
    });

    it('ignores invalid limits and assumes 2 workers under PM2', () => {
      expect(rateLimitConfigFromEnv({RATE_LIMIT_USER_PER_MIN: 'abc'}).limits.user).to.equal(600);
      expect(rateLimitConfigFromEnv({RATE_LIMIT_USER_PER_MIN: '100'}).limits.user).to.equal(100);
      expect(rateLimitConfigFromEnv({}).workers).to.equal(1);
      expect(rateLimitConfigFromEnv({NODE_APP_INSTANCE: '0'}).workers).to.equal(2);
      expect(rateLimitConfigFromEnv({NODE_APP_INSTANCE: '0', RATE_LIMIT_WORKERS: '4'}).workers).to.equal(4);
    });
  });

  describe('createRateLimitMiddleware', () => {
    const config = (mode: RateLimitConfig['mode'], workers = 1): RateLimitConfig => ({
      mode,
      limits: {auth: 2, files: 2, user: 2, anonymous: 2},
      workers,
      jwtSecret: SECRET,
    });
    const run = async (middleware: ReturnType<typeof createRateLimitMiddleware>, times: number) => {
      const headers: Record<string, unknown> = {};
      const context = {
        request: request('GET', '/orders'),
        response: {setHeader: (name: string, value: unknown) => (headers[name] = value)},
      };
      let passed = 0;
      let blocked = 0;
      let error: {statusCode?: number} | undefined;
      for (let i = 0; i < times; i += 1) {
        try {
          await (middleware as (...args: unknown[]) => Promise<unknown>)(context, async () => {
            passed += 1;
          });
        } catch (err) {
          blocked += 1;
          error = err as {statusCode?: number};
        }
      }
      return {passed, blocked, error, headers};
    };
    const originalWarn = console.warn;
    let warnings: string[];
    beforeEach(() => {
      warnings = [];
      console.warn = (message: string) => warnings.push(message);
    });
    afterEach(() => {
      console.warn = originalWarn;
    });

    it('blocks over the limit with a 429 and Retry-After', async () => {
      const result = await run(createRateLimitMiddleware(config('enforce')), 4);
      expect(result).to.containEql({passed: 2, blocked: 2});
      expect(result.error?.statusCode).to.equal(429);
      expect(Number(result.headers['Retry-After'])).to.be.within(1, 60);
    });

    it('only logs in report mode, once per window', async () => {
      const result = await run(createRateLimitMiddleware(config('report')), 5);
      expect(result).to.containEql({passed: 5, blocked: 0});
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.match(/would block anonymous:10\.0\.0\.1 tier=anonymous/);
    });

    it('does nothing when off', async () => {
      const result = await run(createRateLimitMiddleware(config('off')), 5);
      expect(result).to.containEql({passed: 5, blocked: 0});
      expect(warnings).to.be.empty();
    });

    it('gives each worker its share of the limit, and never zero', async () => {
      const shared = {...config('enforce', 2), limits: {auth: 4, files: 4, user: 4, anonymous: 4}};
      expect((await run(createRateLimitMiddleware(shared), 3)).passed).to.equal(2);
      const tiny = {...config('enforce', 8), limits: {auth: 1, files: 1, user: 1, anonymous: 1}};
      expect((await run(createRateLimitMiddleware(tiny), 2)).passed).to.equal(1);
    });
  });
});
