import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, patch, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {PickupEscalationStatus} from '../models/pickup-escalation-status.enum';
import {PickupEscalationRepository} from '../repositories';

/**
 * Admin/support-facing surface for pickup escalations raised via
 * POST /rider/pickup-requests/{id}/escalations (the app's "Raise to
 * support" screen) — a triage queue, kept separate from PickupRequest's
 * own lifecycle since filing one never changes that pickup's status.
 */
export class PickupEscalationController {
  constructor(
    @repository(PickupEscalationRepository) private escalationRepo: PickupEscalationRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_request:read']})
  @get('/pickup-escalations')
  @response(200, {description: 'Pickup escalations, for the support triage queue'})
  async find(@param.query.string('status') status?: PickupEscalationStatus): Promise<object> {
    const escalations = await this.escalationRepo.find({
      where: {isDeleted: false, ...(status ? {status} : {})} as object,
      order: ['raisedAt DESC'],
    });
    return {escalations};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_request:update']})
  @patch('/pickup-escalations/{id}/resolve')
  @response(200, {description: 'Escalation marked resolved'})
  async resolve(
    @param.path.string('id') id: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {'application/json': {schema: {type: 'object', properties: {resolutionRemark: {type: 'string'}}}}},
    })
    body: {resolutionRemark?: string},
  ): Promise<object> {
    const escalation = await this.escalationRepo.findOne({where: {id, isDeleted: false}});
    if (!escalation) throw new HttpErrors.NotFound('Escalation not found.');
    if (escalation.status === PickupEscalationStatus.RESOLVED) {
      throw new HttpErrors.BadRequest('This escalation is already resolved.');
    }

    await this.escalationRepo.updateById(id, {
      status: PickupEscalationStatus.RESOLVED,
      resolvedAt: new Date(),
      resolvedBy: currentUser[securityId],
      resolutionRemark: body.resolutionRemark,
    });

    return {message: 'Escalation resolved.'};
  }
}
