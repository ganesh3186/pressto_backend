import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Employee, EmployeeStore, EmployeeStoreRelations, Store} from '../models';
import {EmployeeRepository} from './employee.repository';
import {StoreRepository} from './store.repository';

export class EmployeeStoreRepository extends TimeStampRepositoryMixin<
  EmployeeStore,
  typeof EmployeeStore.prototype.id,
  Constructor<
    DefaultCrudRepository<EmployeeStore, typeof EmployeeStore.prototype.id, EmployeeStoreRelations>
  >
>(DefaultCrudRepository) {
  public readonly employee: BelongsToAccessor<Employee, typeof EmployeeStore.prototype.id>;
  public readonly store: BelongsToAccessor<Store, typeof EmployeeStore.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('EmployeeRepository') protected employeeRepositoryGetter: Getter<EmployeeRepository>,
    @repository.getter('StoreRepository') protected storeRepositoryGetter: Getter<StoreRepository>,
  ) {
    super(EmployeeStore, dataSource);
    this.employee = this.createBelongsToAccessorFor('employee', employeeRepositoryGetter);
    this.registerInclusionResolver('employee', this.employee.inclusionResolver);
    this.store = this.createBelongsToAccessorFor('store', storeRepositoryGetter);
    this.registerInclusionResolver('store', this.store.inclusionResolver);
  }
}
