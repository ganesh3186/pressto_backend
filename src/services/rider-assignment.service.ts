import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {OrderStatus} from '../models/order-status.enum';
import {PickupRequestStatus} from '../models/pickup-request-status.enum';
import {OrderRepository, PickupRequestRepository, RiderPincodeMappingRepository} from '../repositories';

/**
 * Shared guards for handing a rider new work — used by both
 * order.controller.ts (delivery assignment) and pickup-request.controller.ts
 * (pickup assignment) so the two flows can't drift apart.
 */
@injectable({scope: BindingScope.TRANSIENT})
export class RiderAssignmentService {
  constructor(
    @repository(PickupRequestRepository)
    private pickupRequestRepository: PickupRequestRepository,
    @repository(OrderRepository)
    private orderRepository: OrderRepository,
    @repository(RiderPincodeMappingRepository)
    private riderPincodeMappingRepository: RiderPincodeMappingRepository,
  ) {}

  /**
   * A rider with ANY active pickup run or delivery leg cannot be handed
   * more work until it's done — mirrors the "on-delivery" busy definition
   * in rider-availability.controller.ts, scoped to one rider instead of
   * computed for the whole roster.
   */
  async assertRiderAvailable(riderId: string): Promise<void> {
    const [activePickup, activeOrder] = await Promise.all([
      this.pickupRequestRepository.findOne({
        where: {
          assignedRiderId: riderId,
          isDeleted: false,
          status: {
            inq: [
              PickupRequestStatus.RIDER_ASSIGNED,
              PickupRequestStatus.OUT_FOR_PICKUP,
              PickupRequestStatus.ARRIVED_AT_PICKUP,
              PickupRequestStatus.PICKUP_UNSUCCESSFUL,
            ],
          },
        } as object,
      }),
      this.orderRepository.findOne({
        where: {
          assignedRiderId: riderId,
          isDeleted: false,
          status: {inq: [OrderStatus.READY, OrderStatus.PARTIALLY_DISPATCHED, OrderStatus.OUT_FOR_DELIVERY]},
        } as object,
      }),
    ]);
    if (activePickup ?? activeOrder) {
      throw new HttpErrors.Conflict(
        'This rider already has an active pickup or delivery job and cannot be assigned new work until it is completed.',
      );
    }
  }

  /** Blocks assigning a job to a rider who isn't mapped to cover its pincode. */
  async assertRiderCoversPincode(riderId: string, pincode?: string | null): Promise<void> {
    if (!pincode) return;
    const mapping = await this.riderPincodeMappingRepository.findOne({
      where: {riderId, pincode, isActive: true, isDeleted: false} as object,
    });
    if (!mapping) {
      throw new HttpErrors.BadRequest(`This rider is not mapped to pincode ${pincode}.`);
    }
  }
}
