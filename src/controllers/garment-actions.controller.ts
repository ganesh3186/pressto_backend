import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, patch, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {GARMENT_STATUS_RANK, GarmentStatus} from '../models/garment-status.enum';
import {ApprovalService} from '../services/approval.service';
import {StoreScopeService} from '../services/store-scope.service';
import {OrderService} from '../services/order.service';
import {GarmentAdditionalServiceRepository} from '../repositories/garment-additional-service.repository';
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
    @inject('services.store-scope') private storeScopeService: StoreScopeService,
    @inject('services.order') private orderService: OrderService,
    @repository(ApprovalRequestRepository) private approvalRequestRepo: ApprovalRequestRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(ServiceRepository) private serviceRepo: ServiceRepository,
    @repository(BagRepository) private bagRepo: BagRepository,
    @repository(GarmentAdditionalServiceRepository)
    private garmentAdditionalServiceRepo: GarmentAdditionalServiceRepository,
  ) {}

  // ─── Return Item ──────────────────────────────────────────────────────────
  // Garment goes straight to returned_to_customer at REQUEST time (see
  // ApprovalService's GARMENT_STATUS_ON_CREATE) — approval is a side
  // process from here on, it only gates the MONEY side (order total
  // reduction, refund-due creation via _applyReturnEffect), not the
  // garment's own status. If rejected, the garment resumes wherever it
  // was before (_resumeGarmentFromHold).

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
    await this.storeScopeService.assertGarmentEditable(id, currentUser);
    const garment = await this.garmentRepo.findOne({where: {id, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');

    if (
      garment.status === GarmentStatus.RETURNED_TO_CUSTOMER ||
      garment.status === GarmentStatus.DELIVERED
    ) {
      throw new HttpErrors.BadRequest(`Garment is already ${garment.status}.`);
    }

    await this._guardNoPendingRequest(id, ApprovalRequestType.RETURN_ITEM);

    const returnCalculation =
      await this.approvalService.calculateGarmentReturnAmount(id);

    const request = await this.approvalService.createRequest({
      type: ApprovalRequestType.RETURN_ITEM,
      entityType: 'garment',
      entityId: id,
      requestedBy: currentUser[securityId],
      requestReason: body.reason,
      mediaIds: body.mediaIds,
      metadata: {remarks: body.remarks},
    });

    return {
      message: 'Garment marked returned to customer. Refund, if any, awaits ASM approval.',
      request,
      returnCalculation,
    };
  }

  // ─── Upgrade Service ──────────────────────────────────────────────────────
  // Garment put on hold immediately. Two independent, combinable parts:
  // - toServiceId (optional): OVERRIDES the garment's current primary
  //   service, exactly like before.
  // - additionalServiceIds (optional): ATTACHED alongside whichever primary
  //   service ends up in effect, additive-only — never removes an existing
  //   add-on. Same eligibility gate the POS screen relies on server-side
  //   (resolvePricing() throwing when no ServiceItemMapping/basePrice exists
  //   for the (service, item) pair), not a separate allow-list check.
  // At least one of the two must be present.
  // On customer approve → see ApprovalService._applyUpgradeOnOrderItem.
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
            properties: {
              toServiceId: {type: 'string', format: 'uuid'},
              additionalServiceIds: {type: 'array', items: {type: 'string', format: 'uuid'}},
              remarks: {type: 'string'},
              mediaIds: {type: 'array', items: {type: 'string', format: 'uuid'}},
            },
          },
        },
      },
    })
    body: {
      toServiceId?: string;
      additionalServiceIds?: string[];
      remarks?: string;
      mediaIds?: string[];
    },
  ): Promise<object> {
    await this.storeScopeService.assertGarmentEditable(id, currentUser);
    const garment = await this.garmentRepo.findOne({where: {id, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');

    const orderItem = await this.orderItemRepo.findOne({where: {id: garment.orderItemId}});
    if (!orderItem) throw new HttpErrors.UnprocessableEntity('Order item not found for garment.');

    const requestedAddlIds = Array.from(
      new Set((body.additionalServiceIds ?? []).filter(Boolean)),
    );

    if (!body.toServiceId && requestedAddlIds.length === 0) {
      throw new HttpErrors.BadRequest('Select a new service, add-on services, or both.');
    }

    let toService: {id: string; name?: string} | null = null;
    if (body.toServiceId) {
      toService = await this.serviceRepo.findOne({
        where: {id: body.toServiceId, isDeleted: false, isActive: true},
      });
      if (!toService) throw new HttpErrors.NotFound('Target service not found.');
      if (orderItem.serviceId === body.toServiceId) {
        throw new HttpErrors.BadRequest('Garment is already on that service.');
      }
    }

    // Additive-only: drop any requested add-on already attached to this
    // garment rather than erroring, so re-submitting an existing selection
    // doesn't block a legitimate new one alongside it.
    const existingAddlServices = await this.garmentAdditionalServiceRepo.find({
      where: {garmentId: id, isDeleted: false} as any,
    });
    const existingAddlServiceIds = new Set(existingAddlServices.map(s => s.serviceId));
    const newAddlIds = requestedAddlIds.filter(sid => !existingAddlServiceIds.has(sid));

    if (requestedAddlIds.length > 0 && newAddlIds.length === 0) {
      throw new HttpErrors.BadRequest(
        'All selected add-on services are already attached to this garment.',
      );
    }

    if (!body.toServiceId && newAddlIds.length === 0) {
      throw new HttpErrors.BadRequest('Select a new service, add-on services, or both.');
    }

    const addlServiceNames = new Map<string, string>();
    if (newAddlIds.length > 0) {
      const order = await this.orderRepo.findOne({where: {id: orderItem.orderId}});
      if (!order) throw new HttpErrors.UnprocessableEntity('Order not found for garment.');

      for (const addlId of newAddlIds) {
        const addlService = await this.serviceRepo.findOne({
          where: {id: addlId, isDeleted: false, isActive: true},
        });
        if (!addlService) throw new HttpErrors.NotFound(`Add-on service ${addlId} not found.`);
        addlServiceNames.set(addlId, (addlService as any).name);
        // Same server-side gate POS/order-edit rely on — throws BadRequest
        // when no ServiceItemMapping/basePrice exists for this pairing.
        await this.orderService.resolvePricing(order.storeId, addlId, orderItem.itemId, {
          additional: true,
        });
      }
    }

    await this._guardNoPendingRequest(id, ApprovalRequestType.UPGRADE_SERVICE);

    const request = await this.approvalService.createRequest({
      type: ApprovalRequestType.UPGRADE_SERVICE,
      entityType: 'garment',
      entityId: id,
      requestedBy: currentUser[securityId],
      requestReason: body.remarks,
      mediaIds: body.mediaIds,
      metadata: {
        ...(toService ? {toServiceId: toService.id, toServiceName: (toService as any).name} : {}),
        ...(newAddlIds.length
          ? {
              additionalServiceIds: newAddlIds,
              additionalServiceNames: newAddlIds.map(sid => addlServiceNames.get(sid)),
            }
          : {}),
      },
    });

    const messageParts: string[] = [];
    if (toService) messageParts.push(`upgrade to "${(toService as any).name}"`);
    if (newAddlIds.length) messageParts.push(`${newAddlIds.length} add-on service(s)`);

    return {
      message: `Requested ${messageParts.join(' and ')}. Garment on hold pending customer approval.`,
      request,
    };
  }

  // ─── Process at Risk ──────────────────────────────────────────────────────
  // Raised when a garment can't be safely processed as ordered AND no
  // upgrade removes the risk either — a separate action from Request
  // Upgrade, not a third option inside it. Garment put on hold immediately.
  // On customer approve → garment resumes processing, no service/price
  // change. On reject+return → returned unprocessed, same as any other type.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['approval:create']})
  @post('/garments/{id}/action/risk-approval')
  @response(200, {description: 'Process-at-risk approval request raised, garment put on hold'})
  async requestRiskApproval(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['reason'],
            properties: {
              reason: {type: 'string'},
              mediaIds: {type: 'array', items: {type: 'string', format: 'uuid'}},
            },
          },
        },
      },
    })
    body: {reason: string; mediaIds?: string[]},
  ): Promise<object> {
    await this.storeScopeService.assertGarmentEditable(id, currentUser);
    const garment = await this.garmentRepo.findOne({where: {id, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');

    if (!body.reason?.trim()) {
      throw new HttpErrors.BadRequest('Explain the risk before raising this request.');
    }

    await this._guardNoPendingRequest(id, ApprovalRequestType.PROCESS_AT_RISK);

    const request = await this.approvalService.createRequest({
      type: ApprovalRequestType.PROCESS_AT_RISK,
      entityType: 'garment',
      entityId: id,
      requestedBy: currentUser[securityId],
      requestReason: body.reason,
      mediaIds: body.mediaIds,
    });

    return {
      message: 'Risk approval requested. Garment on hold pending customer approval.',
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
    await this.storeScopeService.assertGarmentEditable(id, currentUser);
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
    await this.storeScopeService.assertGarmentEditable(id, currentUser);
    const garment = await this.garmentRepo.findOne({where: {id, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');

    // A garment still somewhere in the pipeline (rank 0-4, i.e. anything before
    // out_for_delivery) hasn't left the store yet — reprocessing it is a normal
    // workflow correction, not a decision that needs a store exec's sign-off.
    // Approval-gating is reserved for a garment already dispatched/delivered:
    // on_hold and returned_to_customer (rank -1) fall through to it too, since
    // those are already special-cased states, not plain pipeline stages.
    const garmentRank = GARMENT_STATUS_RANK[garment.status as GarmentStatus] ?? -1;
    const isPreDispatch = garmentRank >= 0 && garmentRank < GARMENT_STATUS_RANK[GarmentStatus.OUT_FOR_DELIVERY];

    if (isPreDispatch) {
      await this.approvalService.applyReprocessDirectly(id, currentUser[securityId], body.remarks);
      return {message: 'Garment sent back for reprocessing.'};
    }

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
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<object> {
    await this.storeScopeService.assertGarmentEditable(id, currentUser);
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
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
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
    await this.storeScopeService.assertGarmentEditable(id, currentUser);
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
