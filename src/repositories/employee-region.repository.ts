import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Employee, EmployeeRegion, EmployeeRegionRelations, Region} from '../models';
import {EmployeeRepository} from './employee.repository';
import {RegionRepository} from './region.repository';

export class EmployeeRegionRepository extends TimeStampRepositoryMixin<
  EmployeeRegion,
  typeof EmployeeRegion.prototype.id,
  Constructor<
    DefaultCrudRepository<EmployeeRegion, typeof EmployeeRegion.prototype.id, EmployeeRegionRelations>
  >
>(DefaultCrudRepository) {
  public readonly employee: BelongsToAccessor<Employee, typeof EmployeeRegion.prototype.id>;
  public readonly region: BelongsToAccessor<Region, typeof EmployeeRegion.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('EmployeeRepository') protected employeeRepositoryGetter: Getter<EmployeeRepository>,
    @repository.getter('RegionRepository') protected regionRepositoryGetter: Getter<RegionRepository>,
  ) {
    super(EmployeeRegion, dataSource);
    this.employee = this.createBelongsToAccessorFor('employee', employeeRepositoryGetter);
    this.registerInclusionResolver('employee', this.employee.inclusionResolver);
    this.region = this.createBelongsToAccessorFor('region', regionRepositoryGetter);
    this.registerInclusionResolver('region', this.region.inclusionResolver);
  }
}
