import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Cluster, Employee, EmployeeCluster, EmployeeClusterRelations} from '../models';
import {ClusterRepository} from './cluster.repository';
import {EmployeeRepository} from './employee.repository';

export class EmployeeClusterRepository extends TimeStampRepositoryMixin<
  EmployeeCluster,
  typeof EmployeeCluster.prototype.id,
  Constructor<
    DefaultCrudRepository<EmployeeCluster, typeof EmployeeCluster.prototype.id, EmployeeClusterRelations>
  >
>(DefaultCrudRepository) {
  public readonly employee: BelongsToAccessor<Employee, typeof EmployeeCluster.prototype.id>;
  public readonly cluster: BelongsToAccessor<Cluster, typeof EmployeeCluster.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('EmployeeRepository') protected employeeRepositoryGetter: Getter<EmployeeRepository>,
    @repository.getter('ClusterRepository') protected clusterRepositoryGetter: Getter<ClusterRepository>,
  ) {
    super(EmployeeCluster, dataSource);
    this.employee = this.createBelongsToAccessorFor('employee', employeeRepositoryGetter);
    this.registerInclusionResolver('employee', this.employee.inclusionResolver);
    this.cluster = this.createBelongsToAccessorFor('cluster', clusterRepositoryGetter);
    this.registerInclusionResolver('cluster', this.cluster.inclusionResolver);
  }
}
