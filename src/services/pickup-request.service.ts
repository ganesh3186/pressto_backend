import {BindingScope, inject, injectable} from '@loopback/core';
import {DataObject, Options, repository} from '@loopback/repository';
import {PickupRequest} from '../models';
import {PickupRequestStatus} from '../models/pickup-request-status.enum';
import {PickupRequestRepository} from '../repositories';
import {afterWhatsAppCommit, WhatsAppService} from './whatsapp.service';

/** Shared customer/admin/rider pickup operations; repositories only persist data. */
@injectable({scope: BindingScope.TRANSIENT})
export class PickupRequestService {
  constructor(
    @repository(PickupRequestRepository)
    private pickupRepository: PickupRequestRepository,
    @inject('services.whatsapp') private whatsAppService: WhatsAppService,
  ) {}

  async createRequest(
    data: DataObject<PickupRequest>,
    options?: Options,
  ): Promise<PickupRequest> {
    const pickup = await this.pickupRepository.create(data, options);
    afterWhatsAppCommit(options, () =>
      this.whatsAppService.notifyPickup(pickup.id, 'created'),
    );
    return pickup;
  }

  async assignRider(
    previous: PickupRequest,
    assignment: DataObject<PickupRequest>,
    options?: Options,
  ): Promise<void> {
    await this.pickupRepository.updateById(previous.id, assignment, options);
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
    afterWhatsAppCommit(options, () =>
      this.whatsAppService.notifyPickup(previous.id, 'scheduled', key),
    );
  }
}
