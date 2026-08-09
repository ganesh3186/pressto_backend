import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Customer, Order, PickupRequest, PickupRequestRelations, Rider, Store} from '../models';
import {CustomerRepository} from './customer.repository';
import {OrderRepository} from './order.repository';
import {RiderRepository} from './rider.repository';
import {StoreRepository} from './store.repository';

export class PickupRequestRepository extends TimeStampRepositoryMixin<
  PickupRequest,
  typeof PickupRequest.prototype.id,
  Constructor<
    DefaultCrudRepository<
      PickupRequest,
      typeof PickupRequest.prototype.id,
      PickupRequestRelations
    >
  >
>(DefaultCrudRepository) {
  public readonly customer: BelongsToAccessor<Customer, typeof PickupRequest.prototype.id>;
  public readonly store: BelongsToAccessor<Store, typeof PickupRequest.prototype.id>;
  public readonly assignedRider: BelongsToAccessor<Rider, typeof PickupRequest.prototype.id>;
  public readonly convertedOrder: BelongsToAccessor<Order, typeof PickupRequest.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('CustomerRepository') protected customerRepositoryGetter: Getter<CustomerRepository>,
    @repository.getter('StoreRepository') protected storeRepositoryGetter: Getter<StoreRepository>,
    @repository.getter('RiderRepository') protected riderRepositoryGetter: Getter<RiderRepository>,
    @repository.getter('OrderRepository') protected orderRepositoryGetter: Getter<OrderRepository>,
  ) {
    super(PickupRequest, dataSource);
    this.customer = this.createBelongsToAccessorFor('customer', customerRepositoryGetter);
    this.registerInclusionResolver('customer', this.customer.inclusionResolver);
    this.store = this.createBelongsToAccessorFor('store', storeRepositoryGetter);
    this.registerInclusionResolver('store', this.store.inclusionResolver);
    this.assignedRider = this.createBelongsToAccessorFor('assignedRider', riderRepositoryGetter);
    this.registerInclusionResolver('assignedRider', this.assignedRider.inclusionResolver);
    this.convertedOrder = this.createBelongsToAccessorFor('convertedOrder', orderRepositoryGetter);
    this.registerInclusionResolver('convertedOrder', this.convertedOrder.inclusionResolver);
  }
}
