import {Entity, model, property} from '@loopback/repository';
import {TransferItemScanStatus} from './transfer-item-status.enum';

/**
 * One row per garment in a Transfer's manifest — normalized, not a jsonb
 * array on Transfer. Item Tracking (GET /transfers/item/{tag}) needs
 * "which transfer is this specific tag in right now" as a real, indexed
 * lookup, the same reasoning already applied to RiderPincodeMapping
 * (normalized rows because pincode-keyed lookup needed to be a real query,
 * not an array scan). SalesReturn.returnedItems stays jsonb because
 * nothing ever queries into it by item — write-once, read-whole-record-back.
 * This is the opposite case.
 *
 * No soft-delete trio — a manifest line is permanent once created; there's
 * no removal path this pass ("wrong scan removed" is an in-browser,
 * pre-submit concern, never persisted).
 */
@model({
  settings: {
    postgresql: {table: 'transfer_item', schema: 'public'},
    indexes: {
      // Item Tracking's core query: "which transfer, if any, is this tag in".
      garmentTagLookup: {keys: ['garmentTagNumber']},
    },
  },
})
export class TransferItem extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  transferId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  garmentId: string;

  // Denormalized snapshot — safe: Garment.garmentTagNumber has a unique
  // index and is never reassigned after tagging.
  @property({type: 'string', required: true})
  garmentTagNumber: string;

  // Denormalized — resolved once at creation via Garment.orderItemId →
  // OrderItem.orderId (batched, not per-row), saves a join on every read.
  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  orderId: string;

  @property({
    type: 'string',
    default: TransferItemScanStatus.SCANNED,
    jsonSchema: {enum: Object.values(TransferItemScanStatus)},
  })
  scanStatus?: TransferItemScanStatus;

  // Only meaningful when scanStatus = missing — why it's presumed missing.
  @property({type: 'string', postgresql: {dataType: 'text'}})
  removedReason?: string;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<TransferItem>) {
    super(data);
  }
}

export interface TransferItemRelations {}
export type TransferItemWithRelations = TransferItem & TransferItemRelations;
