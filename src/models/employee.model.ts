import {Entity, model, property, belongsTo} from '@loopback/repository';
import {Users} from './users.model';
import {Media} from './media.model';
import {Store} from './store.model';

@model({
  settings: {
    postgresql: {
      table: 'employee',
      schema: 'public',
    },
    indexes: {
      uniqueEmployeeCode: {
        keys: ['employeeCode'],
        options: {unique: true},
      },
    },
  },
})
export class Employee extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @belongsTo(() => Users)
  userId: string;

  @property({type: 'string', required: true})
  employeeCode: string;

  @property({type: 'string', required: true})
  firstName: string;

  @property({type: 'string', required: true})
  lastName: string;

  @property({type: 'date'})
  dateOfBirth?: Date;

  @property({type: 'date'})
  joiningDate?: Date;

  @property({type: 'string'})
  designation?: string;

  @property({type: 'string'})
  department?: string;

  @belongsTo(() => Media)
  mediaId?: string;

  @belongsTo(() => Store)
  storeId?: string;

  // Direct scope bindings used when the employee's role is cluster- or
  // region-scoped (store-scoped roles use storeId instead). See Roles.scope.
  @property({
    type: 'string',
    postgresql: {dataType: 'uuid'},
  })
  clusterId?: string;

  @property({
    type: 'string',
    postgresql: {dataType: 'uuid'},
  })
  regionId?: string;

  @property({
    type: 'string',
    postgresql: {dataType: 'uuid'},
  })
  reportingManagerId?: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'text'}})
  addressLine1: string;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  addressLine2?: string;

  @property({type: 'string', required: true})
  city: string;

  @property({type: 'string', required: true})
  state: string;

  @property({type: 'string', required: true})
  pincode: string;

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

  constructor(data?: Partial<Employee>) {
    super(data);
  }
}

export interface EmployeeRelations {
  user?: Users;
  media?: Media;
  store?: Store;
}

export type EmployeeWithRelations = Employee & EmployeeRelations;
