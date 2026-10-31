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
  debug: true,
  // Previously unset, so pg.Pool defaulted to max:10 and no connection
  // timeout — once all 10 were busy (slow unindexed queries, wildcard
  // searches), every other request queued forever with no error, looking
  // like the whole app had hung. A bounded wait at least fails fast and
  // surfaces in logs instead of hanging the UI indefinitely.
  max: 20,
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
