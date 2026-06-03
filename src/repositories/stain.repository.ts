import {inject} from '@loopback/core';
import {DefaultCrudRepository, juggler} from '@loopback/repository';
import {Stain, StainRelations} from '../models/stain.model';

export class StainRepository extends DefaultCrudRepository<
  Stain,
  typeof Stain.prototype.id,
  StainRelations
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(Stain, dataSource);
  }
}
