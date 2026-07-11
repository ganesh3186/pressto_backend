import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Invoice, InvoiceRelations} from '../models/invoice.model';

export class InvoiceRepository extends TimeStampRepositoryMixin<
  Invoice,
  typeof Invoice.prototype.id,
  Constructor<DefaultCrudRepository<Invoice, typeof Invoice.prototype.id, InvoiceRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(Invoice, dataSource);
  }
}
