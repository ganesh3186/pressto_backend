import {inject, lifeCycleObserver, LifeCycleObserver} from '@loopback/core';
import {juggler} from '@loopback/repository';
import * as dotenv from 'dotenv';
dotenv.config();

const config = {
  name: 'pressto',
  connector: 'postgresql',
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT),
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
  // Previously unset, so pg.Pool defaulted to max:10 and no connection
  // timeout — once all 10 were busy (slow unindexed queries, wildcard
  // searches), every other request queued forever with no error, looking
  // like the whole app had hung. A bounded wait at least fails fast and
  // surfaces in logs instead of hanging the UI indefinitely.
  //
  // Configurable via PG_POOL_MAX because PM2 cluster mode (see
  // ecosystem.config.js) runs several instances of this process, EACH with
  // its OWN pool of this size — total DB connections from this app alone is
  // roughly `PM2_INSTANCES * PG_POOL_MAX`, which has to fit under Postgres's
  // max_connections alongside every other environment sharing this server
  // (migration, staging). Defaults to 15/instance; with the 2-instance
  // default in ecosystem.config.js that's 30 total for production — verify
  // actual `max_connections` on the server and tune both knobs together
  // before raising either one.
  max: Number(process.env.PG_POOL_MAX) || 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};


// Observe application's life cycle to disconnect the datasource when
// application is stopped. This allows the application to be shut down
// gracefully. The `stop()` method is inherited from `juggler.DataSource`.
// Learn more at https://loopback.io/doc/en/lb4/Life-cycle.html
@lifeCycleObserver('datasource')
export class PresstoDataSource extends juggler.DataSource
  implements LifeCycleObserver {
  static dataSourceName = 'pressto';
  static readonly defaultConfig = config;

  constructor(
    @inject('datasources.config.pressto', {optional: true})
    dsConfig: object = config,
  ) {
    super(dsConfig);
  }
}
