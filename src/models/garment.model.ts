import {Entity, model, property} from '@loopback/repository';
import {GarmentStatus} from './garment-status.enum';
import {UnprocessedHandlingMode} from './unprocessed-handling-mode.enum';

@model({
  settings: {
    postgresql: {table: 'garment', schema: 'public'},
    indexes: {
      uniqueGarmentTagNumber: {keys: ['garmentTagNumber'], options: {unique: true}},
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
