import {Entity, model, property} from '@loopback/repository';

@model({
  settings: {
    postgresql: {
      table: 'delivery_type_configuration',
      schema: 'public',
    },
  },
})
export class DeliveryTypeConfiguration extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @property({
    type: 'number',
    required: true,
    postgresql: {dataType: 'numeric'},
  })
  standardPercentage: number;

  @property({
    type: 'number',
    required: true,
    postgresql: {dataType: 'numeric'},
  })
  expressPercentage: number;

  @property({
    type: 'number',
    required: true,
    postgresql: {dataType: 'numeric'},
  })
  lightningPercentage: number;

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

  constructor(data?: Partial<DeliveryTypeConfiguration>) {
    super(data);
  }
}

export interface DeliveryTypeConfigurationRelations {}

export type DeliveryTypeConfigurationWithRelations = DeliveryTypeConfiguration &
  DeliveryTypeConfigurationRelations;
