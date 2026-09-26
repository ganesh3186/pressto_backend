import {Entity, belongsTo, model, property} from '@loopback/repository';
import {Cluster} from './cluster.model';
import {Employee} from './employee.model';

/**
 * An ADDITIONAL cluster a cluster-scoped employee (ASM) can act on, beyond
 * their primary Employee.clusterId. Same "join table alongside the primary
 * field" precedent as EmployeeStore — see that model's comment.
 */
@model({
  settings: {
    postgresql: {table: 'employee_cluster', schema: 'public'},
    indexes: {
      uniqueEmployeeCluster: {keys: ['employeeId', 'clusterId'], options: {unique: true}},
    },
  },
})
export class EmployeeCluster extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @belongsTo(() => Employee)
  employeeId: string;

  @belongsTo(() => Cluster)
  clusterId: string;

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

  constructor(data?: Partial<EmployeeCluster>) {
    super(data);
  }
}

export interface EmployeeClusterRelations {
  employee?: Employee;
  cluster?: Cluster;
}

export type EmployeeClusterWithRelations = EmployeeCluster & EmployeeClusterRelations;
