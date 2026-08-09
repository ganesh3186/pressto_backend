import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Rider, RiderPincodeMapping, RiderPincodeMappingRelations} from '../models';
import {RiderRepository} from './rider.repository';

export class RiderPincodeMappingRepository extends TimeStampRepositoryMixin<
  RiderPincodeMapping,
  typeof RiderPincodeMapping.prototype.id,
  Constructor<
    DefaultCrudRepository<
      RiderPincodeMapping,
      typeof RiderPincodeMapping.prototype.id,
      RiderPincodeMappingRelations
    >
  >
>(DefaultCrudRepository) {
  public readonly rider: BelongsToAccessor<Rider, typeof RiderPincodeMapping.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('RiderRepository') protected riderRepositoryGetter: Getter<RiderRepository>,
  ) {
    super(RiderPincodeMapping, dataSource);
    this.rider = this.createBelongsToAccessorFor('rider', riderRepositoryGetter);
    this.registerInclusionResolver('rider', this.rider.inclusionResolver);
  }
}
