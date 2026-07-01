import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {GarmentDamageImage, GarmentDamageImageRelations, GarmentDamage, Media} from '../models';
import {GarmentDamageRepository} from './garment-damage.repository';
import {MediaRepository} from './media.repository';

export class GarmentDamageImageRepository extends TimeStampRepositoryMixin<
  GarmentDamageImage,
  typeof GarmentDamageImage.prototype.id,
  Constructor<DefaultCrudRepository<GarmentDamageImage, typeof GarmentDamageImage.prototype.id, GarmentDamageImageRelations>>
>(DefaultCrudRepository) {
  public readonly garmentDamage: BelongsToAccessor<GarmentDamage, typeof GarmentDamageImage.prototype.id>;
  public readonly media: BelongsToAccessor<Media, typeof GarmentDamageImage.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('GarmentDamageRepository') protected garmentDamageRepositoryGetter: Getter<GarmentDamageRepository>,
    @repository.getter('MediaRepository') protected mediaRepositoryGetter: Getter<MediaRepository>,
  ) {
    super(GarmentDamageImage, dataSource);
    this.garmentDamage = this.createBelongsToAccessorFor('garmentDamage', garmentDamageRepositoryGetter);
    this.registerInclusionResolver('garmentDamage', this.garmentDamage.inclusionResolver);
    this.media = this.createBelongsToAccessorFor('media', mediaRepositoryGetter);
    this.registerInclusionResolver('media', this.media.inclusionResolver);
  }
}
