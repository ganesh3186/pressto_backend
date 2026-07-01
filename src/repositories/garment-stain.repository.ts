import {Constructor, Getter, inject} from '@loopback/core';
import {DefaultCrudRepository, HasManyRepositoryFactory, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {GarmentStain, GarmentStainRelations, GarmentStainImage} from '../models';
import {GarmentStainImageRepository} from './garment-stain-image.repository';

export class GarmentStainRepository extends TimeStampRepositoryMixin<
  GarmentStain,
  typeof GarmentStain.prototype.id,
  Constructor<DefaultCrudRepository<GarmentStain, typeof GarmentStain.prototype.id, GarmentStainRelations>>
>(DefaultCrudRepository) {
  public readonly images: HasManyRepositoryFactory<GarmentStainImage, typeof GarmentStain.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('GarmentStainImageRepository') protected garmentStainImageRepositoryGetter: Getter<GarmentStainImageRepository>,
  ) {
    super(GarmentStain, dataSource);
    this.images = this.createHasManyRepositoryFactoryFor('images', garmentStainImageRepositoryGetter);
    this.registerInclusionResolver('images', this.images.inclusionResolver);
  }
}
