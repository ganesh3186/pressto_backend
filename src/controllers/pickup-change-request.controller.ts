import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {PickupRequestRepository, PickupChangeRequestRepository} from '../repositories';

/**
 * Records the real order (built on POS) deviating from what the linked
 * pickup request actually said — see PickupChangeRequest's own doc
 * comment for why this doesn't (yet) notify the customer for real.
 */
export class PickupChangeRequestController {
  constructor(
    @repository(PickupChangeRequestRepository) private changeRequestRepo: PickupChangeRequestRepository,
    @repository(PickupRequestRepository) private pickupRequestRepo: PickupRequestRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_request:update']})
  @post('/pickup-requests/{id}/change-requests')
  @response(200, {description: 'Pickup change request recorded'})
  async create(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['orderId', 'originalItems', 'changedItems'],
            properties: {
              orderId: {type: 'string', format: 'uuid'},
              originalItems: {type: 'array', items: {type: 'object'}},
              changedItems: {type: 'array', items: {type: 'object'}},
              changeSummary: {type: 'string'},
            },
          },
        },
      },
    })
    body: {orderId: string; originalItems: object[]; changedItems: object[]; changeSummary?: string},
  ): Promise<object> {
    const pickupRequest = await this.pickupRequestRepo.findOne({where: {id, isDeleted: false}});
    if (!pickupRequest) throw new HttpErrors.NotFound('Pickup request not found.');

    const {v4} = await import('uuid');
    const changeRequest = await this.changeRequestRepo.create({
      id: v4(),
      pickupRequestId: id,
      orderId: body.orderId,
      customerId: pickupRequest.customerId,
      originalItems: body.originalItems,
      changedItems: body.changedItems,
      changeSummary: body.changeSummary,
      createdBy: currentUser[securityId],
    });

    return {message: 'Pickup change request recorded.', changeRequest};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_request:read']})
  @get('/pickup-requests/{id}/change-requests')
  @response(200, {description: 'Change requests recorded against this pickup'})
  async find(@param.path.string('id') id: string): Promise<object> {
    const changeRequests = await this.changeRequestRepo.find({
      where: {pickupRequestId: id} as object,
      order: ['createdAt DESC'],
    });
    return {changeRequests};
  }
}
