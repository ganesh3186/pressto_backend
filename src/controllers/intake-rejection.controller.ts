import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {
  IntakeRejectedItem,
  IntakeRejectionOutcome,
  IntakeRejectionReason,
  IntakeRejectionStatus,
} from '../models/intake-rejected-item.model';
import {
  GarmentRepository,
  IntakeRejectedItemRepository,
  OrderItemRepository,
  OrderRepository,
} from '../repositories';

export class IntakeRejectionController {
  constructor(
    @repository(IntakeRejectedItemRepository) private intakeRejectedRepo: IntakeRejectedItemRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
  ) {}

  // ─── Reject an item at intake ─────────────────────────────────────────────
  // Called when staff want to flag an order item as rejected at intake.
  // Creates a pending rejection record; a manager then resolves it.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @post('/orders/{orderId}/items/{orderItemId}/intake-reject')
  @response(200, {description: 'Item flagged as rejected at intake'})
  async rejectItem(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('orderId') orderId: string,
    @param.path.string('orderItemId') orderItemId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['reason'],
            properties: {
              reason: {
                type: 'string',
                enum: Object.values(IntakeRejectionReason),
              },
              garmentId: {type: 'string', format: 'uuid'},
              remarks: {type: 'string'},
              mediaIds: {type: 'array', items: {type: 'string', format: 'uuid'}},
            },
          },
        },
      },
    })
    body: {
      reason: IntakeRejectionReason;
      garmentId?: string;
      remarks?: string;
      mediaIds?: string[];
    },
  ): Promise<object> {
    const order = await this.orderRepo.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const orderItem = await this.orderItemRepo.findOne({where: {id: orderItemId, orderId}});
    if (!orderItem) throw new HttpErrors.NotFound('Order item not found.');

    if (body.garmentId) {
      const garment = await this.garmentRepo.findOne({where: {id: body.garmentId, orderItemId, isDeleted: false}});
      if (!garment) throw new HttpErrors.NotFound('Garment not found on this order item.');
    }

    // Guard: one pending rejection per order item
    const existing = await this.intakeRejectedRepo.findOne({
      where: {orderItemId, status: IntakeRejectionStatus.PENDING} as any,
    });
    if (existing) {
      throw new HttpErrors.Conflict('A pending intake rejection already exists for this order item.');
    }

    const {v4} = await import('uuid');
    const record = await this.intakeRejectedRepo.create({
      id: v4(),
      orderId,
      orderItemId,
      garmentId: body.garmentId,
      reason: body.reason,
      remarks: body.remarks,
      mediaIds: body.mediaIds,
      handledBy: currentUser[securityId],
      status: IntakeRejectionStatus.PENDING,
    } as Partial<IntakeRejectedItem>);

    return {message: 'Item flagged as rejected at intake. Awaiting manager resolution.', record};
  }

  // ─── Resolve intake rejection ─────────────────────────────────────────────
  // Manager picks an outcome: process anyway | upgrade | return to customer.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @post('/orders/{orderId}/items/{orderItemId}/intake-resolve')
  @response(200, {description: 'Intake rejection resolved'})
  async resolveRejection(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('orderId') orderId: string,
    @param.path.string('orderItemId') orderItemId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['outcome'],
            properties: {
              outcome: {type: 'string', enum: Object.values(IntakeRejectionOutcome)},
              outcomeRemarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {outcome: IntakeRejectionOutcome; outcomeRemarks?: string},
  ): Promise<object> {
    const record = await this.intakeRejectedRepo.findOne({
      where: {orderItemId, orderId, status: IntakeRejectionStatus.PENDING} as any,
    });
    if (!record) {
      throw new HttpErrors.NotFound('No pending intake rejection found for this order item.');
    }

    await this.intakeRejectedRepo.updateById(record.id, {
      status: IntakeRejectionStatus.RESOLVED,
      outcome: body.outcome,
      outcomeRemarks: body.outcomeRemarks,
      resolvedBy: currentUser[securityId],
      resolvedAt: new Date(),
    } as Partial<IntakeRejectedItem>);

    return {
      message: `Intake rejection resolved. Outcome: ${body.outcome}.`,
      recordId: record.id,
      outcome: body.outcome,
    };
  }

  // ─── List rejections for an order ─────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders/{orderId}/intake-rejections')
  @response(200, {description: 'Intake rejections for an order'})
  async listForOrder(@param.path.string('orderId') orderId: string): Promise<object> {
    const records = await this.intakeRejectedRepo.find({
      where: {orderId} as any,
      order: ['createdAt DESC'],
    });
    return {rejections: records};
  }
}
