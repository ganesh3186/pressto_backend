import {Constructor, Getter, inject} from '@loopback/core';
import {DefaultCrudRepository, HasManyRepositoryFactory, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {GarmentDamage, GarmentDamageRelations, GarmentDamageImage} from '../models';
import {GarmentDamageImageRepository} from './garment-damage-image.repository';

export class GarmentDamageRepository extends TimeStampRepositoryMixin<
  GarmentDamage,
  typeof GarmentDamage.prototype.id,
  Constructor<DefaultCrudRepository<GarmentDamage, typeof GarmentDamage.prototype.id, GarmentDamageRelations>>
>(DefaultCrudRepository) {
  public readonly images: HasManyRepositoryFactory<GarmentDamageImage, typeof GarmentDamage.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('GarmentDamageImageRepository') protected garmentDamageImageRepositoryGetter: Getter<GarmentDamageImageRepository>,
  ) {
    super(GarmentDamage, dataSource);
    this.images = this.createHasManyRepositoryFactoryFor('images', garmentDamageImageRepositoryGetter);
    this.registerInclusionResolver('images', this.images.inclusionResolver);
  }
}
