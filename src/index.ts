import * as dotenv from 'dotenv';
// Load environment variables FIRST before any other imports
dotenv.config();

import {ApplicationConfig, presstoBackendApplication} from './application';
export * from './application';

// Which proxy may report the real client IP (Express "trust proxy"). Default
// `loopback` fits nginx on the same server. Behind an AWS load balancer set
// TRUST_PROXY=1, otherwise every client shares the balancer's IP and the
// per-IP rate limits apply to all users together.
export function trustProxySetting(
  value = process.env.TRUST_PROXY,
): boolean | number | string {
  if (!value) return 'loopback';
  if (value === 'true' || value === 'false') return value === 'true';
  const hops = Number(value);
  return Number.isInteger(hops) && hops >= 0 ? hops : value;
}

export async function main(options: ApplicationConfig = {}) {
  const app = new presstoBackendApplication(options);
  await app.boot();
  await require('../scripts/add-coupon-ticket-visibility.cjs').addCouponTicketVisibility();
  await app.start();
  const url = app.restServer.url;
  console.log(`Server is running at ${url}`);
  console.log(`Try ${url}/ping`);

  return app;
}

// PM2 cluster mode loads this file through its own ProcessContainer, so
// require.main is PM2's wrapper, not this module, and the app would never
// listen. PM2 sets NODE_APP_INSTANCE on every cluster worker.
if (require.main === module || process.env.NODE_APP_INSTANCE !== undefined) {
  // Run the application
  const config = {
    rest: {
      port: +(process.env.PORT ?? 3000),
      // client-server branch only: defaults to listening on every
      // interface, not just loopback, since this deployment is reached by
      // other devices on the LAN via its own IP (admin-panel/customer-web
      // both call that IP directly, baked in at their own build time) —
      // 127.0.0.1 would refuse those connections outright even with a
      // correct .env, if HOST ever went unset. Still fully overridable via
      // .env's HOST for a server that genuinely wants loopback-only.
      host: process.env.HOST ?? '0.0.0.0',
      // Only a trusted proxy may say who the real client is, so a client
      // reaching a Node port directly can't fake its IP. See trustProxySetting.
      expressSettings: {'trust proxy': trustProxySetting()},
      // The `gracePeriodForClose` provides a graceful close for http/https
      // servers with keep-alive clients. The default value is `Infinity`
      // (don't force-close). If you want to immediately destroy all sockets
      // upon stop, set its value to `0`.
      // See https://www.npmjs.com/package/stoppable
      gracePeriodForClose: 5000, // 5 seconds
      openApiSpec: {
        // useful when used with OpenAPI-to-GraphQL to locate your application
        setServersFromRequest: true,
      },
    },
  };
  main(config).catch(err => {
    console.error('Cannot start the application.', err);
    process.exit(1);
  });
}
