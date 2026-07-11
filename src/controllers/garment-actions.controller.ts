import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, patch, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {GarmentStatus} from '../models/garment-status.enum';
import {ApprovalService} from '../services/approval.service';
import {
  ApprovalRequestRepository,
  BagRepository,
  GarmentRepository,
  OrderItemRepository,
  OrderRepository,
  ServiceRepository,
} from '../repositories';

export class GarmentActionsController {
  constructor(
    @inject('services.approval') private approvalService: ApprovalService,
    @repository(ApprovalRequestRepository) private approvalRequestRepo: ApprovalRequestRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(ServiceRepository) private serviceRepo: ServiceRepository,
    @repository(BagRepository) private bagRepo: BagRepository,
  ) {}

  // ─── Return Item ──────────────────────────────────────────────────────────
  // No status change on garment at request time.
  // On ASM approval → directly returned_to_customer.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['approval:create']})
  @post('/garments/{id}/action/return')
  @response(200, {description: 'Return approval request raised'})
  async requestReturn(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              reason: {type: 'string'},
              remarks: {type: 'string'},
              mediaIds: {type: 'array', items: {type: 'string', format: 'uuid'}},
            },
          },
        },
      },
    })
    body: {reason?: string; remarks?: string; mediaIds?: string[]},
  ): Promise<object> {
    const garment = await this.garmentRepo.findOne({where: {id, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');

    if (
      garment.status === GarmentStatus.RETURNED_TO_CUSTOMER ||
      garment.status === GarmentStatus.DELIVERED
    ) {
      throw new HttpErrors.BadRequest(`Garment is already ${garment.status}.`);
    }

    await this._guardNoPendingRequest(id, ApprovalRequestType.RETURN_ITEM);

    const request = await this.approvalService.createRequest({
      type: ApprovalRequestType.RETURN_ITEM,
      entityType: 'garment',
      entityId: id,
      requestedBy: currentUser[securityId],
      requestReason: body.reason,
      mediaIds: body.mediaIds,
      metadata: {remarks: body.remarks},
    });

    return {message: 'Return request raised. Awaiting ASM approval.', request};
  }

  // ─── Upgrade Service ──────────────────────────────────────────────────────
  // Garment put on hold immediately.
  // On customer approve → serviceId updated, price recalculated, garment → in_inspection.
  // On reject → garment restored to previous status.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['approval:create']})
  @post('/garments/{id}/action/upgrade')
  @response(200, {description: 'Upgrade approval request raised, garment put on hold'})
  async requestUpgrade(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['toServiceId'],
            properties: {
              toServiceId: {type: 'string', format: 'uuid'},
              remarks: {type: 'string'},
              mediaIds: {type: 'array', items: {type: 'string', format: 'uuid'}},
            },
          },
        },
      },
    })
    body: {toServiceId: string; remarks?: string; mediaIds?: string[]},
  ): Promise<object> {
    const garment = await this.garmentRepo.findOne({where: {id, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');

    const toService = await this.serviceRepo.findOne({
      where: {id: body.toServiceId, isDeleted: false, isActive: true},
    });
    if (!toService) throw new HttpErrors.NotFound('Target service not found.');

    const orderItem = await this.orderItemRepo.findOne({where: {id: garment.orderItemId}});
    if (!orderItem) throw new HttpErrors.UnprocessableEntity('Order item not found for garment.');

    if (orderItem.serviceId === body.toServiceId) {
      throw new HttpErrors.BadRequest('Garment is already on that service.');
    }

    await this._guardNoPendingRequest(id, ApprovalRequestType.UPGRADE_SERVICE);

    const request = await this.approvalService.createRequest({
      type: ApprovalRequestType.UPGRADE_SERVICE,
      entityType: 'garment',
      entityId: id,
      requestedBy: currentUser[securityId],
      requestReason: body.remarks,
      mediaIds: body.mediaIds,
      metadata: {toServiceId: body.toServiceId, toServiceName: (toService as any).name},
    });

    return {
      message: `Upgrade to "${(toService as any).name}" requested. Garment on hold pending customer approval.`,
      request,
    };
  }

  // ─── Mark Damaged ─────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['approval:create']})
  @post('/garments/{id}/action/mark-damaged')
  @response(200, {description: 'Damaged-in-process report raised'})
  async markDamaged(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              remarks: {type: 'string'},
              mediaIds: {type: 'array', items: {type: 'string', format: 'uuid'}},
            },
          },
        },
      },
    })
    body: {remarks?: string; mediaIds?: string[]},
  ): Promise<object> {
    const garment = await this.garmentRepo.findOne({where: {id, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');

    await this._guardNoPendingRequest(id, ApprovalRequestType.ITEM_DAMAGED);

    const request = await this.approvalService.createRequest({
      type: ApprovalRequestType.ITEM_DAMAGED,
      entityType: 'garment',
      entityId: id,
      requestedBy: currentUser[securityId],
      requestReason: body.remarks,
      mediaIds: body.mediaIds,
    });

    return {message: 'Damaged report raised. Awaiting store exec action.', request};
  }

  // ─── Reprocess ───────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['approval:create']})
  @post('/garments/{id}/action/reprocess')
  @response(200, {description: 'Reprocess approval request raised'})
  async requestReprocess(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              remarks: {type: 'string'},
              mediaIds: {type: 'array', items: {type: 'string', format: 'uuid'}},
            },
          },
        },
      },
    })
    body: {remarks?: string; mediaIds?: string[]},
  ): Promise<object> {
    const garment = await this.garmentRepo.findOne({where: {id, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');

    await this._guardNoPendingRequest(id, ApprovalRequestType.REPROCESS);

    const request = await this.approvalService.createRequest({
      type: ApprovalRequestType.REPROCESS,
      entityType: 'garment',
      entityId: id,
      requestedBy: currentUser[securityId],
      requestReason: body.remarks,
      mediaIds: body.mediaIds,
    });

    return {message: 'Reprocess request raised. Awaiting store exec approval.', request};
  }

  // ─── Mark Ready to Dispatch ───────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['garment:update']})
  @patch('/garments/{id}/mark-ready-dispatch')
  @response(200, {description: 'Garment flagged for dispatch'})
  async markReadyDispatch(
    @param.path.string('id') id: string,
  ): Promise<object> {
    const garment = await this.garmentRepo.findOne({where: {id, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');

    if (garment.status !== GarmentStatus.READY) {
      throw new HttpErrors.BadRequest(
        `Garment must be in 'ready' status to mark for dispatch. Current: '${garment.status}'.`,
      );
    }

    await this.garmentRepo.updateById(id, {readyForDispatch: true} as any);
    return {message: 'Garment flagged for dispatch.'};
  }

  // ─── Change Bag ──────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['garment:update']})
  @patch('/garments/{id}/change-bag')
  @response(200, {description: 'Garment bag updated'})
  async changeBag(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['bagId'],
            properties: {bagId: {type: 'string', format: 'uuid'}},
          },
        },
      },
    })
    body: {bagId: string},
  ): Promise<object> {
    const garment = await this.garmentRepo.findOne({where: {id, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');

    const bag = await this.bagRepo.findOne({where: {id: body.bagId}} as any);
    if (!bag) throw new HttpErrors.NotFound('Bag not found.');

    await this.garmentRepo.updateById(id, {bagId: body.bagId} as any);
    return {message: 'Bag updated.', bagId: body.bagId};
  }

  // ─── Validate Scan ────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['garment:read']})
  @get('/garments/validate-scan')
  @response(200, {description: 'Scan validation result'})
  async validateScan(@param.query.string('q') q: string): Promise<object> {
    if (!q?.trim()) return {valid: false, reason: 'Empty scan value.'};

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid = uuidRegex.test(q.trim());

    const garment = isUuid
      ? await this.garmentRepo.findOne({where: {id: q.trim(), isDeleted: false}})
      : await this.garmentRepo.findOne({where: {garmentTagNumber: q.trim(), isDeleted: false}});

    if (!garment) return {valid: false, reason: `No garment found for "${q}".`};

    const orderItem = await this.orderItemRepo.findOne({where: {id: garment.orderItemId}});
    const order = orderItem?.orderId
      ? await this.orderRepo.findOne({where: {id: orderItem.orderId}})
      : null;

    return {
      valid: true,
      garmentId: garment.id,
      garmentTagNumber: garment.garmentTagNumber,
      status: garment.status,
      orderId: orderItem?.orderId ?? null,
      orderNumber: (order as any)?.orderNumber ?? null,
    };
  }

  // ─── Guard helper ─────────────────────────────────────────────────────────

  private async _guardNoPendingRequest(garmentId: string, type: ApprovalRequestType): Promise<void> {
    const existing = await this.approvalRequestRepo.findOne({
      where: {
        entityType: 'garment',
        entityId: garmentId,
        type,
        status: ApprovalRequestStatus.PENDING,
      } as any,
    });
    if (existing) {
      throw new HttpErrors.Conflict(`A pending ${type} request already exists for this garment.`);
    }
  }
}
