import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {PettyCashRegisterEntry, PettyCashRegisterEntryRelations} from '../models/petty-cash-register-entry.model';

export class PettyCashRegisterEntryRepository extends TimeStampRepositoryMixin<
  PettyCashRegisterEntry,
  typeof PettyCashRegisterEntry.prototype.id,
  Constructor<
    DefaultCrudRepository<PettyCashRegisterEntry, typeof PettyCashRegisterEntry.prototype.id, PettyCashRegisterEntryRelations>
  >
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(PettyCashRegisterEntry, dataSource);
  }
}
