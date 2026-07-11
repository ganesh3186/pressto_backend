import {Entity, model, property} from '@loopback/repository';

export enum ChallanStatus {
  DRAFT = 'draft',
  ISSUED = 'issued',
  CONVERTED_TO_INVOICE = 'converted_to_invoice',
}

@model({
  settings: {
    postgresql: {table: 'challan', schema: 'public'},
    indexes: {
      uniqueChallanNumber: {keys: ['challanNumber'], options: {unique: true}},
    },
  },
})
export class Challan extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  orderId: string;

  @property({type: 'string', required: true})
  challanNumber: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  generatedBy: string;

  // Snapshot of all line items at the time of challan generation
  @property({type: 'array', itemType: 'object', postgresql: {dataType: 'jsonb'}})
  items?: object[];

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  subtotal?: number;

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  discount?: number;

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  deliveryCharge?: number;

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  cgst?: number;

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  sgst?: number;

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  totalAmount?: number;

  @property({
    type: 'string',
    default: ChallanStatus.DRAFT,
    jsonSchema: {enum: Object.values(ChallanStatus)},
  })
  status?: ChallanStatus;

  @property({type: 'boolean', default: false})
  isPrinted?: boolean;

  @property({type: 'date'})
  printedAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<Challan>) {
    super(data);
  }
}

export interface ChallanRelations {}
export type ChallanWithRelations = Challan & ChallanRelations;
