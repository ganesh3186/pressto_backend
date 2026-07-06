import {Entity, model, property} from '@loopback/repository';
import {ProcessLogStatus} from './process-log-status.enum';

@model({
  settings: {
    postgresql: {table: 'garment_process_log', schema: 'public'},
    indexes: {
      idxGarmentProcessLog: {keys: ['garmentId', 'serviceSequence', 'stepSequence'], options: {}},
    },
  },
})
export class GarmentProcessLog extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  garmentId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  orderItemId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  serviceId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  processStepId: string;

  // 1 = primary service, 2+ = additional services (in staff-decided order)
  @property({type: 'number', required: true})
  serviceSequence: number;

  // Step order within the service (from ServiceProcessMapping.sequence)
  @property({type: 'number', required: true})
  stepSequence: number;

  @property({
    type: 'string',
    default: ProcessLogStatus.PENDING,
    jsonSchema: {enum: Object.values(ProcessLogStatus)},
  })
  status?: ProcessLogStatus;

  @property({type: 'date'})
  startedAt?: Date;

  @property({type: 'date'})
  completedAt?: Date;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  startedBy?: string;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  completedBy?: string;

  // Was a QR scan recorded for this step
  @property({type: 'boolean', default: false})
  qrScanned?: boolean;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  remarks?: string;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<GarmentProcessLog>) {
    super(data);
  }
}

export interface GarmentProcessLogRelations {}
export type GarmentProcessLogWithRelations = GarmentProcessLog & GarmentProcessLogRelations;
