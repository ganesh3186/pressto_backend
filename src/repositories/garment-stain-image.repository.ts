import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {GarmentStainImage, GarmentStainImageRelations, GarmentStain, Media} from '../models';
import {GarmentStainRepository} from './garment-stain.repository';
import {MediaRepository} from './media.repository';

export class GarmentStainImageRepository extends TimeStampRepositoryMixin<
  GarmentStainImage,
  typeof GarmentStainImage.prototype.id,
  Constructor<DefaultCrudRepository<GarmentStainImage, typeof GarmentStainImage.prototype.id, GarmentStainImageRelations>>
>(DefaultCrudRepository) {
  public readonly garmentStain: BelongsToAccessor<GarmentStain, typeof GarmentStainImage.prototype.id>;
  public readonly media: BelongsToAccessor<Media, typeof GarmentStainImage.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('GarmentStainRepository') protected garmentStainRepositoryGetter: Getter<GarmentStainRepository>,
    @repository.getter('MediaRepository') protected mediaRepositoryGetter: Getter<MediaRepository>,
  ) {
    super(GarmentStainImage, dataSource);
    this.garmentStain = this.createBelongsToAccessorFor('garmentStain', garmentStainRepositoryGetter);
    this.registerInclusionResolver('garmentStain', this.garmentStain.inclusionResolver);
    this.media = this.createBelongsToAccessorFor('media', mediaRepositoryGetter);
    this.registerInclusionResolver('media', this.media.inclusionResolver);
  }
}
