import {Entity, belongsTo, model, property} from '@loopback/repository';
import {Employee} from './employee.model';
import {Store} from './store.model';

/**
 * An ADDITIONAL store a store-scoped employee can act on, beyond their
 * primary Employee.storeId. Kept as a separate join table rather than
 * widening storeId into an array, so every existing consumer that reads
 * Employee.storeId as "their one store" (shift-open/petty-cash
 * auto-default, New Order's store auto-pin, the login response) keeps
 * working unchanged for the common single-store case — see
 * StoreScopeService.allStoreIdsForEmployee(), which unions this table with
 * the primary storeId for the actual access-control decision.
 */
@model({
  settings: {
    postgresql: {table: 'employee_store', schema: 'public'},
    indexes: {
      uniqueEmployeeStore: {keys: ['employeeId', 'storeId'], options: {unique: true}},
    },
  },
})
export class EmployeeStore extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @belongsTo(() => Employee)
  employeeId: string;

  @belongsTo(() => Store)
  storeId: string;

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

  constructor(data?: Partial<EmployeeStore>) {
    super(data);
  }
}

export interface EmployeeStoreRelations {
  employee?: Employee;
  store?: Store;
}

export type EmployeeStoreWithRelations = EmployeeStore & EmployeeStoreRelations;
