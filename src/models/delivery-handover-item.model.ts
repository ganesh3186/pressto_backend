import {Entity, model, property} from '@loopback/repository';

@model({
  settings: {
    postgresql: {
      table: 'delivery_handover_item',
      schema: 'public',
    },
    indexes: {
      deliveryHandoverItemParent: {keys: ['deliveryHandoverId']},
      deliveryHandoverOrder: {keys: ['orderId']},
    },
  },
})
export class DeliveryHandoverItem extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  deliveryHandoverId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  deliveryOrderId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  orderId: string;

  @property({type: 'string', required: true})
  orderNumber: string;

  @property({type: 'string', required: true})
  customerName: string;

  @property({type: 'string', required: true})
  previousStopStatus: string;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  constructor(data?: Partial<DeliveryHandoverItem>) {
    super(data);
  }
}

export interface DeliveryHandoverItemRelations {}
export type DeliveryHandoverItemWithRelations = DeliveryHandoverItem &
  DeliveryHandoverItemRelations;
