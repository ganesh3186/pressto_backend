import {Entity, model, property} from '@loopback/repository';
import {AdditionalChargeType} from './additional-charge-type.enum';
import {AdditionalChargeScope} from './additional-charge-scope.enum';

@model({
  settings: {
    postgresql: {
      table: 'additional_charge_master',
      schema: 'public',
    },
    indexes: {
      uniqueAdditionalChargeMasterCode: {
        keys: ['code'],
        options: {unique: true},
      },
    },
  },
})
export class AdditionalChargeMaster extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @property({type: 'string', required: true})
  name: string;

  @property({type: 'string', required: true})
  code: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {enum: Object.values(AdditionalChargeScope)},
  })
  chargeScope: AdditionalChargeScope;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {enum: Object.values(AdditionalChargeType)},
  })
  chargeType: AdditionalChargeType;

  @property({
    type: 'number',
    required: true,
    postgresql: {dataType: 'numeric'},
  })
  defaultAmount: number;

  @property({type: 'boolean', default: false})
  isTaxable?: boolean;

  @property({type: 'string'})
  description?: string;

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

  constructor(data?: Partial<AdditionalChargeMaster>) {
    super(data);
  }
}

export interface AdditionalChargeMasterRelations {}

export type AdditionalChargeMasterWithRelations = AdditionalChargeMaster &
  AdditionalChargeMasterRelations;
