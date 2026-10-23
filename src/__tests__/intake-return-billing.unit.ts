/* eslint-disable @typescript-eslint/no-explicit-any -- Repository stubs use partial records. */
import {expect} from '@loopback/testlab';
import {securityId} from '@loopback/security';
import {IntakeRejectionController} from '../controllers/intake-rejection.controller';
import {IntakeRejectionReason} from '../models/intake-rejected-item.model';
import {GarmentStatus} from '../models/garment-status.enum';

describe('direct intake return billing', () => {
  it('recalculates the challan when a garment is returned', async () => {
    const garment = {id: 'garment-1', status: GarmentStatus.RECEIVED};
    const calls: string[] = [];
    const controller = Object.assign(
      Object.create(IntakeRejectionController.prototype),
      {
        orderRepo: {findOne: async () => ({id: 'order-1'})},
        orderItemRepo: {findOne: async () => ({id: 'item-1'})},
        garmentRepo: {
          findOne: async () => garment,
          updateById: async (_id: string, patch: any) =>
            Object.assign(garment, patch),
        },
        garmentStatusHistoryRepo: {create: async () => {}},
        intakeRejectedRepo: {create: async (record: any) => record},
        challanRepo: {findOne: async () => ({id: 'challan-1'})},
        orderService: {
          syncChallanTotalsForOrder: async (orderId: string) =>
            calls.push(orderId),
        },
      },
    ) as IntakeRejectionController;

    await controller.rejectItem(
      {[securityId]: 'staff-1'} as any,
      'order-1',
      'item-1',
      {
        reason: IntakeRejectionReason.OTHER,
        garmentId: garment.id,
        directReturn: true,
      },
    );

    expect(garment.status).to.equal(GarmentStatus.RETURNED_TO_CUSTOMER);
    expect(calls).to.eql(['order-1']);
  });
});
