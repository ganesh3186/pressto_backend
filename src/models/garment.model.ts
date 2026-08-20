import {Entity, model, property} from '@loopback/repository';
import {GarmentStatus} from './garment-status.enum';
import {UnprocessedHandlingMode} from './unprocessed-handling-mode.enum';

@model({
  settings: {
    postgresql: {table: 'garment', schema: 'public'},
    indexes: {
      uniqueGarmentTagNumber: {keys: ['garmentTagNumber'], options: {unique: true}},
      garmentActiveTransferId: {keys: ['activeTransferId']},
    },
  },
})
export class Garment extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  orderItemId: string;

  @property({type: 'string', required: true})
  garmentTagNumber: string;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  brandId?: string;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  colorId?: string;

  // Metres — only set (and only meaningful) when the item is priced by
  // measurement (Item.isMeasurement), e.g. curtains billed per square metre.
  // Priced as length × width (area) × the item's resolved unit price.
  @property({type: 'number', postgresql: {dataType: 'numeric'}})
  length?: number;

  @property({type: 'number', postgresql: {dataType: 'numeric'}})
  width?: number;

  @property({type: 'string'})
  qrCode?: string;

  @property({
    type: 'string',
    default: GarmentStatus.RECEIVED,
    jsonSchema: {enum: Object.values(GarmentStatus)},
  })
  status?: GarmentStatus;

  @property({type: 'number', default: 1})
  qrPrintCount?: number;

  // Bag this garment is currently assigned to (changed via scan workflow)
  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  bagId?: string;

  // Denormalized dual-access grant, mirrors Bag.currentTransferId's
  // pattern. Set to a Transfer's id when this garment is cleanly confirmed
  // received at a store OTHER than its order's home store
  // (transfer.controller.ts's receive()/resolveDiscrepancy()) — grants
  // that store additional access alongside the home store, which never
  // loses it. Cleared back to null once the garment is received back at
  // its home store (a return-batch's own receive() call, since a return's
  // toStoreId is always the origin).
  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  activeTransferId?: string;

  // Set true when garment is flagged for dispatch batch (status = ready)
  @property({type: 'boolean', default: false})
  readyForDispatch?: boolean;

  // Set to true when the QR tag is first printed — locks the order for approval flow (T-07)
  @property({type: 'boolean', default: false})
  isTagPrinted?: boolean;

  // How unprocessed items were handled at delivery
  @property({
    type: 'string',
    jsonSchema: {enum: Object.values(UnprocessedHandlingMode)},
  })
  unprocessedHandlingMode?: UnprocessedHandlingMode;

  // Customer's verbal remarks when dropping off
  @property({type: 'string', postgresql: {dataType: 'text'}})
  customerRemarks?: string;

  // Staff remarks during inspection
  @property({type: 'string', postgresql: {dataType: 'text'}})
  inspectionRemarks?: string;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  @property({type: 'date'})
  deletedAt?: Date;

  constructor(data?: Partial<Garment>) {
    super(data);
  }
}

export interface GarmentRelations {}
export type GarmentWithRelations = Garment & GarmentRelations;
