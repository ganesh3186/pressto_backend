import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {PickupDeliverySlot, PickupDeliverySlotRelations} from '../models/pickup-delivery-slot.model';

export class PickupDeliverySlotRepository extends TimeStampRepositoryMixin<
  PickupDeliverySlot,
  typeof PickupDeliverySlot.prototype.id,
  Constructor<
    DefaultCrudRepository<
      PickupDeliverySlot,
      typeof PickupDeliverySlot.prototype.id,
      PickupDeliverySlotRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(PickupDeliverySlot, dataSource);
  }
}
