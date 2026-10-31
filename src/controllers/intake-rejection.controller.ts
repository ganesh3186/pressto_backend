import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {IsolationLevel, repository} from '@loopback/repository';
import {get, HttpErrors, param, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {PresstoDataSource} from '../datasources';
import {
  IntakeRejectedItem,
  IntakeRejectionOutcome,
  IntakeRejectionReason,
  IntakeRejectionStatus,
} from '../models/intake-rejected-item.model';
import {GarmentStatus} from '../models/garment-status.enum';
import {ApprovalActionType} from '../models/approval-action-type.enum';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {
  ApprovalRequestRepository,
  ChallanRepository,
  GarmentRepository,
  IntakeRejectedItemRepository,
  OrderItemRepository,
  OrderRepository,
} from '../repositories';
import {ApprovalService} from '../services/approval.service';
import {OrderService} from '../services/order.service';
import {StoreScopeService} from '../services/store-scope.service';

export class IntakeRejectionController {
  constructor(
    @repository(IntakeRejectedItemRepository) private intakeRejectedRepo: IntakeRejectedItemRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @repository(ChallanRepository) private challanRepo: ChallanRepository,
    @repository(ApprovalRequestRepository) private approvalRequestRepo: ApprovalRequestRepository,
    @inject('datasources.pressto') private dataSource: PresstoDataSource,
    @inject('services.approval') private approvalService: ApprovalService,
    @inject('services.order') private orderService: OrderService,
    @inject('services.store-scope') private storeScopeService: StoreScopeService,
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
              // Reject-at-intake from the Create Order inspection popup: no
              // approval step — the garment is returned to the customer at once.
              directReturn: {type: 'boolean'},
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
      directReturn?: boolean;
    },
  ): Promise<object> {
    const order = await this.orderRepo.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const orderItem = await this.orderItemRepo.findOne({where: {id: orderItemId, orderId}});
    if (!orderItem) throw new HttpErrors.NotFound('Order item not found.');

    const garment = body.garmentId
      ? await this.garmentRepo.findOne({where: {id: body.garmentId, orderItemId, isDeleted: false}})
      : null;
    if (body.garmentId && !garment) throw new HttpErrors.NotFound('Garment not found on this order item.');

    const {v4} = await import('uuid');

    // Direct intake return: billing is immediate and no approval remains pending.
    // Shared return billing creates any refund due before this record is resolved.
    if (body.directReturn) {
      if (!body.garmentId) {
        throw new HttpErrors.BadRequest('A garment is required to reject and return at intake.');
      }
      const performedBy = currentUser[securityId];
      const createResolvedRecord = () => this.intakeRejectedRepo.create({
        id: v4(),
        orderId,
        orderItemId,
        garmentId: body.garmentId,
        reason: body.reason,
        remarks: body.remarks,
        mediaIds: body.mediaIds,
        handledBy: performedBy,
        status: IntakeRejectionStatus.RESOLVED,
        outcome: IntakeRejectionOutcome.RETURN_TO_CUSTOMER,
        resolvedBy: performedBy,
        resolvedAt: new Date(),
      } as Partial<IntakeRejectedItem>);
      const syncChallan = async () => {
        const challan = await this.challanRepo.findOne({where: {orderId}});
        if (challan) await this.orderService.syncChallanTotalsForOrder(orderId, challan);
      };
      const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
      try {
        await this.dataSource.execute(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          [`direct-intake-return:${body.garmentId}`],
          {transaction: tx},
        );
        const currentGarment = await this.garmentRepo.findOne({
          where: {id: body.garmentId, orderItemId, isDeleted: false},
        });
        if (currentGarment?.status === GarmentStatus.RETURNED_TO_CUSTOMER) {
          let record = await this.intakeRejectedRepo.findOne({where: {
            orderId,
            orderItemId,
            garmentId: body.garmentId,
            status: IntakeRejectionStatus.RESOLVED,
            outcome: IntakeRejectionOutcome.RETURN_TO_CUSTOMER,
          }});
          if (!record) {
            const approvals = await this.approvalRequestRepo.find({
              where: {
                type: ApprovalRequestType.RETURN_ITEM,
                entityType: 'garment',
                entityId: body.garmentId,
              },
              order: ['createdAt DESC'],
            });
            const request = approvals.find(
              approval => approval.metadata?.source === 'direct_intake_return',
            );
            if (!request) throw new HttpErrors.Conflict('Garment has already been returned.');
            if (request.status === ApprovalRequestStatus.PENDING) {
              await this.approvalService.resolve({
                requestId: request.id,
                action: ApprovalActionType.APPROVED,
                performedBy,
                comments: 'Direct return at intake',
                approvalSource: 'direct',
              });
            }
            record = await createResolvedRecord();
          }
          await syncChallan();
          await tx.commit();
          return {message: 'Garment rejected at intake and returned to customer.', record};
        }

        const request = await this.approvalService.createRequest({
          type: ApprovalRequestType.RETURN_ITEM,
          entityType: 'garment',
          entityId: body.garmentId,
          requestedBy: performedBy,
          requestReason: `Rejected at intake (${body.reason})${body.remarks ? ` — ${body.remarks}` : ''}`,
          mediaIds: body.mediaIds,
          metadata: {source: 'direct_intake_return'},
        });
        await this.approvalService.resolve({
          requestId: request.id,
          action: ApprovalActionType.APPROVED,
          performedBy,
          comments: 'Direct return at intake',
          approvalSource: 'direct',
        });

        const record = await createResolvedRecord();
        await syncChallan();
        await tx.commit();
        return {message: 'Garment rejected at intake and returned to customer.', record};
      } catch (error) {
        await tx.rollback();
        throw error;
      }
    }

    // ── Standard flow: create a pending rejection for manager resolution ─────
    // Guard: one pending rejection per order item
    const existing = await this.intakeRejectedRepo.findOne({
      where: {orderItemId, status: IntakeRejectionStatus.PENDING} as any,
    });
    if (existing) {
      throw new HttpErrors.Conflict('A pending intake rejection already exists for this order item.');
    }

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
  async listForOrder(
    @param.path.string('orderId') orderId: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser?: UserProfile,
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(orderId, currentUser!);

    const records = await this.intakeRejectedRepo.find({
      where: {orderId} as any,
      order: ['createdAt DESC'],
    });
    return {rejections: records};
  }
}
