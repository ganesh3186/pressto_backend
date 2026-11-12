import {authenticate} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {get, response} from '@loopback/rest';
import {createHash} from 'crypto';
import {PresstoDataSource} from '../datasources';

/**
 * Tables behind the master lists the admin panel caches (New Order catalog,
 * prices, coupons, labels, stores). Every one is written through a repository
 * using TimeStampRepositoryMixin, so any create/update/soft-delete moves its
 * max(updatedat); the row count catches hard deletes. Tables that orders also
 * write to are fingerprinted by content instead (MASTER_DATA_CONTENT_COLUMNS).
 */
export const MASTER_DATA_TABLES = [
  'additional_charge_master',
  'brand',
  'cluster',
  'cluster_price_list',
  'color',
  'coupon',
  'coupon_price_override',
  'customer_discount_group',
  'customer_label',
  'damage_type',
  'delivery_type_configuration',
  'gst_tax_configuration',
  'item',
  'item_category',
  'order_label',
  'price_list',
  'region',
  'service',
  'service_category',
  'service_item_mapping',
  'stain',
  'store',
  'store_price_override',
  'store_service_mapping',
] as const;

/**
 * Tables that normal order-taking also writes to, so max(updatedat) would move
 * on every order and make the admin panel re-download its master lists all day:
 * - store: isprefixlocked is set (via the timestamp mixin) and
 *   ordernumbersequence is bumped (raw SQL) when an order is created.
 * - coupon: totalusescount (and with it updatedat/updatedby) changes whenever a
 *   coupon is redeemed or released.
 * For these, fingerprint only the columns an admin edits; counters, locks and
 * timestamps are left out.
 */
export const MASTER_DATA_CONTENT_COLUMNS: Partial<Record<(typeof MASTER_DATA_TABLES)[number], string[]>> = {
  store: [
    'id', 'clusterid', 'name', 'code', 'storeprefix', 'storetype', 'address', 'city', 'state', 'country',
    'pincode', 'latitude', 'longitude', 'email', 'phone', 'gstnumber', 'isactive', 'isdeleted', 'deletedat',
  ],
  coupon: [
    'id', 'code', 'name', 'description', 'colortag', 'discounttype', 'discountvalue', 'maxdiscountamount',
    'minqualifyingitems', 'startdate', 'enddate', 'maxusespercustomer', 'maxusestotal', 'servicecategoryids',
    'serviceids', 'itemcategoryids', 'itemids', 'regionids', 'clusterids', 'storeids', 'customerlabelids',
    'isreferralcode', 'isactive', 'isdeleted', 'deletedat', 'minrequirementtype', 'minrequirementvalue',
    'newcustomerorderlimit', 'hidefromticketlist',
  ],
};

export const MASTER_DATA_VERSION_SQL = MASTER_DATA_TABLES.map(table => {
  const columns = MASTER_DATA_CONTENT_COLUMNS[table];
  const fingerprint = columns
    ? `coalesce(md5(string_agg(concat_ws('|', ${columns.join(', ')}), ',' ORDER BY id)), '')`
    : `coalesce(max(updatedat)::text, '')`;
  return `SELECT '${table}' AS t, count(*)::text AS n, ${fingerprint} AS u FROM public.${table}`;
}).join(' UNION ALL ');

export function masterDataVersionFrom(rows: {t: string; n: string; u: string}[]): string {
  const signature = [...rows]
    .sort((a, b) => a.t.localeCompare(b.t))
    .map(r => `${r.t}:${r.n}:${r.u}`)
    .join('|');
  return createHash('sha1').update(signature).digest('hex').slice(0, 16);
}

export class MasterDataVersionController {
  constructor(@inject('datasources.pressto') private dataSource: PresstoDataSource) {}

  /**
   * A short fingerprint of all master data. It changes whenever a master row is
   * added, edited or deleted, so the admin panel can poll this (a few bytes)
   * and only re-download its cached master lists when something changed.
   */
  @authenticate('jwt')
  @get('/master-data/version')
  @response(200, {
    description: 'Fingerprint of the master data the admin panel caches',
    content: {
      'application/json': {
        schema: {type: 'object', properties: {version: {type: 'string'}}},
      },
    },
  })
  async getVersion(): Promise<{version: string}> {
    const rows = (await this.dataSource.execute(MASTER_DATA_VERSION_SQL)) as {t: string; n: string; u: string}[];
    return {version: masterDataVersionFrom(rows)};
  }
}
