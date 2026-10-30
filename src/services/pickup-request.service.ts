import {BindingScope, inject, injectable} from '@loopback/core';
import {DataObject, IsolationLevel, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {PickupRequest} from '../models';
import {PickupRequestStatus} from '../models/pickup-request-status.enum';
import {PickupRequestRepository} from '../repositories';
import {dispatchWhatsApp, WhatsAppService} from './whatsapp.service';

/** Shared customer/admin/rider pickup operations; repositories only persist data. */
@injectable({scope: BindingScope.TRANSIENT})
export class PickupRequestService {
  constructor(
    @repository(PickupRequestRepository)
    private pickupRepository: PickupRequestRepository,
    @inject('services.whatsapp') private whatsAppService: WhatsAppService,
    @inject('datasources.pressto') private dataSource: PresstoDataSource,
  ) {}

  async createRequest(data: DataObject<PickupRequest>): Promise<PickupRequest> {
    const pickup = await this.pickupRepository.create(data);
    dispatchWhatsApp(() =>
      this.whatsAppService.notifyPickup(pickup.id, 'created'),
    );
    return pickup;
  }

  async assignRiders(
    requests: PickupRequest[],
    assignment: DataObject<PickupRequest>,
  ): Promise<void> {
    const tx = await this.dataSource.beginTransaction(
      IsolationLevel.READ_COMMITTED,
    );
    try {
      for (const request of requests) {
        await this.pickupRepository.updateById(request.id, assignment, {
          transaction: tx,
        });
      }
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
    for (const request of requests)
      this.notifyRiderAssigned(request, assignment);
  }

  notifyPickedUp(pickupId: string): void {
    dispatchWhatsApp(() =>
      this.whatsAppService.notifyPickup(pickupId, 'completed'),
    );
  }

  private notifyRiderAssigned(
    previous: PickupRequest,
    assignment: DataObject<PickupRequest>,
  ): void {
    if (
      assignment.status !== PickupRequestStatus.RIDER_ASSIGNED ||
      !assignment.assignedRiderId
    )
      return;
    const dateKey = (value: unknown) =>
      value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
    if (
      previous.assignedRiderId === assignment.assignedRiderId &&
      dateKey(previous.requestedDate) === dateKey(assignment.requestedDate) &&
      previous.slot === assignment.slot
    )
      return;
    const key = [
      assignment.assignedRiderId,
      dateKey(assignment.requestedDate),
      assignment.slot,
    ].join(':');
    dispatchWhatsApp(() =>
      this.whatsAppService.notifyPickup(previous.id, 'scheduled', key),
    );
  }
}
