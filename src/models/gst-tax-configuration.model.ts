import {Entity, model, property} from '@loopback/repository';

@model({
  settings: {
    postgresql: {
      table: 'gst_tax_configuration',
      schema: 'public',
    },
  },
})
export class GstTaxConfiguration extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @property({
    type: 'string',
    postgresql: {dataType: 'uuid'},
  })
  hsnSacCodeId?: string;

  @property({
    type: 'number',
    required: true,
    postgresql: {dataType: 'numeric'},
  })
  cgstPercentage: number;

  @property({
    type: 'number',
    required: true,
    postgresql: {dataType: 'numeric'},
  })
  sgstPercentage: number;

  @property({
    type: 'number',
    required: true,
    postgresql: {dataType: 'numeric'},
  })
  igstPercentage: number;

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

  constructor(data?: Partial<GstTaxConfiguration>) {
    super(data);
  }
}

export interface GstTaxConfigurationRelations {}

export type GstTaxConfigurationWithRelations = GstTaxConfiguration &
  GstTaxConfigurationRelations;
