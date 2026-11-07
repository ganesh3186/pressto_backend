import {Entity, model, property} from '@loopback/repository';
import {DeliveryHandoverStatus} from './delivery-handover-status.enum';

@model({
  settings: {
    postgresql: {
      table: 'delivery_handover',
      schema: 'public',
    },
    indexes: {
      deliveryHandoverSender: {keys: ['riderId', 'status']},
      deliveryHandoverRecipient: {keys: ['handoverToRiderId', 'status']},
    },
  },
})
export class DeliveryHandover extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  deliveryId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  riderId: string;

  @property({type: 'string', required: true})
  riderName: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  handoverToRiderId: string;

  @property({type: 'string', required: true})
  handoverToName: string;

  @property({type: 'number', required: true})
  itemCount: number;

  @property({
    type: 'string',
    default: DeliveryHandoverStatus.PENDING,
    jsonSchema: {enum: Object.values(DeliveryHandoverStatus)},
  })
  status?: DeliveryHandoverStatus;

  @property({type: 'date', required: true})
  submittedAt: Date;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  submittedBy: string;

  @property({type: 'date'})
  confirmedAt?: Date;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  confirmedBy?: string;

  @property({type: 'date'})
  cancelledAt?: Date;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  cancelledBy?: string;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  remarks?: string;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<DeliveryHandover>) {
    super(data);
  }
}

export interface DeliveryHandoverRelations {}
export type DeliveryHandoverWithRelations = DeliveryHandover &
  DeliveryHandoverRelations;
