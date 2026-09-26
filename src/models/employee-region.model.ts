import {Entity, belongsTo, model, property} from '@loopback/repository';
import {Employee} from './employee.model';
import {Region} from './region.model';

/**
 * An ADDITIONAL region a region-scoped employee (RM) can act on, beyond
 * their primary Employee.regionId. Same "join table alongside the primary
 * field" precedent as EmployeeStore — see that model's comment.
 */
@model({
  settings: {
    postgresql: {table: 'employee_region', schema: 'public'},
    indexes: {
      uniqueEmployeeRegion: {keys: ['employeeId', 'regionId'], options: {unique: true}},
    },
  },
})
export class EmployeeRegion extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @belongsTo(() => Employee)
  employeeId: string;

  @belongsTo(() => Region)
  regionId: string;

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

  constructor(data?: Partial<EmployeeRegion>) {
    super(data);
  }
}

export interface EmployeeRegionRelations {
  employee?: Employee;
  region?: Region;
}

export type EmployeeRegionWithRelations = EmployeeRegion & EmployeeRegionRelations;
