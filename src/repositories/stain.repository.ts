import { inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import { Stain, StainRelations } from '../models/stain.model';
import { presstoDataSource } from '../datasources';

export class StainRepository extends DefaultCrudRepository<
  Stain,
  typeof Stain.prototype.id,
  StainRelations
> {
  constructor(@inject('datasources.pressto') dataSource: presstoDataSource) {
    super(Stain, dataSource);
  }
}
