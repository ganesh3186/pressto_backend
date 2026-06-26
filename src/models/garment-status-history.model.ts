import {Entity, model, property} from '@loopback/repository';
import {GarmentStatus} from './garment-status.enum';

@model({
  settings: {postgresql: {table: 'garment_status_history', schema: 'public'}},
})
export class GarmentStatusHistory extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  garmentId: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {enum: Object.values(GarmentStatus)},
  })
  status: GarmentStatus;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  remarks?: string;

  @property({type: 'date', defaultFn: 'now'})
  changedAt?: Date;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  changedBy?: string;

  constructor(data?: Partial<GarmentStatusHistory>) {
    super(data);
  }
}

export interface GarmentStatusHistoryRelations {}
export type GarmentStatusHistoryWithRelations = GarmentStatusHistory & GarmentStatusHistoryRelations;
