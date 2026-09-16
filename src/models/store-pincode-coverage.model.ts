import {Entity, belongsTo, model, property} from '@loopback/repository';
import {Store} from './store.model';

/**
 * One row per (store, pincode) the client's delivery-coverage analysis
 * says that store actually serves, with how much of that pincode's area
 * falls in range — seeded wholesale from "Store x Pincode" in the
 * client's Pressto_Cluster_Pincode_Coverage.xlsx (see
 * scripts/migrate-cluster-pincode-coverage.cjs / seed-cluster-pincode-
 * coverage.ts). A pincode may have several rows (several stores covering
 * it, `overlap: true`) — that overlap is the point of this table, not a
 * data-quality issue to dedupe away.
 *
 * region/cluster/storeName are the workbook's own denormalized labels,
 * kept as plain text for reference/debugging — the real relational link
 * is storeId; nothing else in the codebase should join on the text
 * fields.
 *
 * Cluster-level and summary views (the workbook's Cluster Summary, Store
 * Summary, Cluster x Pincode sheets) are deliberately NOT stored here —
 * they're all derivable from this table plus Store.clusterId, so seeding
 * them separately would just be redundant, driftable data.
 */
@model({
  settings: {
    postgresql: {table: 'store_pincode_coverage', schema: 'public'},
  },
})
export class StorePincodeCoverage extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @belongsTo(() => Store)
  storeId: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {pattern: '^[0-9]{6}$'},
  })
  pincode: string;

  // Workbook's own text labels — reference only, see class comment.
  @property({type: 'string'})
  region?: string;

  @property({type: 'string'})
  cluster?: string;

  @property({type: 'string'})
  storeName?: string;

  @property({type: 'number', postgresql: {dataType: 'numeric'}})
  pctOfPincodeInRange?: number;

  @property({type: 'number', postgresql: {dataType: 'numeric'}})
  areaInRangeSqkm?: number;

  @property({type: 'number', postgresql: {dataType: 'numeric'}})
  centroidDistanceKm?: number;

  @property({type: 'boolean'})
  material?: boolean;

  @property({type: 'number'})
  storesCovering?: number;

  @property({type: 'boolean'})
  overlap?: boolean;

  @property({type: 'string'})
  nearestStore?: string;

  @property({type: 'string'})
  boundarySource?: string;

  @property({type: 'boolean', default: true})
  isActive?: boolean;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  @property({type: 'date'})
  deletedAt?: Date;

  constructor(data?: Partial<StorePincodeCoverage>) {
    super(data);
  }
}

export interface StorePincodeCoverageRelations {
  store?: Store;
}

export type StorePincodeCoverageWithRelations = StorePincodeCoverage & StorePincodeCoverageRelations;
