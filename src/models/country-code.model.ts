import {Entity, model, property} from '@loopback/repository';

@model({
  settings: {
    postgresql: {table: 'country_code', schema: 'public'},
    indexes: {
      uniqueCountryIsoCode: {keys: ['isoCode'], options: {unique: true}},
    },
  },
})
export class CountryCode extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true})
  countryName: string;

  @property({type: 'string', required: true})
  isoCode: string;

  @property({type: 'string', required: true})
  dialCode: string;

  @property({type: 'number', default: 100})
  displayOrder?: number;

  @property({type: 'boolean', default: true})
  isActive?: boolean;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<CountryCode>) {
    super(data);
  }
}

export interface CountryCodeRelations {}
export type CountryCodeWithRelations = CountryCode & CountryCodeRelations;
