import {authenticate} from '@loopback/authentication';
import {Filter, repository} from '@loopback/repository';
import {del, get, HttpErrors, param, patch, post, requestBody, response} from '@loopback/rest';
import {authorize} from '../authorization';
import {RiderPincodeMapping} from '../models';
import {RiderPincodeMappingRepository, RiderRepository} from '../repositories';

const PINCODE_PATTERN = /^[0-9]{6}$/;

export class RiderPincodeMappingController {
  constructor(
    @repository(RiderPincodeMappingRepository)
    private mappingRepository: RiderPincodeMappingRepository,
    @repository(RiderRepository)
    private riderRepository: RiderRepository,
  ) {}

  // ─── Validation helpers ───────────────────────────────────────────────────

  private assertPincodeFormat(pincode: string) {
    if (!PINCODE_PATTERN.test(pincode)) {
      throw new HttpErrors.BadRequest(`"${pincode}" is not a valid 6-digit pincode.`);
    }
  }

  private async assertRiderActive(riderId: string) {
    const rider = await this.riderRepository.findOne({where: {id: riderId, isDeleted: false}});
    if (!rider) throw new HttpErrors.NotFound('Rider not found.');
    if (!rider.isActive) throw new HttpErrors.BadRequest('This rider is inactive.');
  }

  /** A pincode can only be covered by one active rider at a time. */
  private async assertPincodeFree(pincode: string, ignoreMappingId?: string) {
    const existing = await this.mappingRepository.findOne({
      where: {pincode, isActive: true, isDeleted: false} as object,
      include: [{relation: 'rider'}],
    });
    if (existing && existing.id !== ignoreMappingId) {
      const riderLabel = existing.rider
        ? `${existing.rider.riderCode} (${existing.rider.firstName} ${existing.rider.lastName})`
        : 'another rider';
      throw new HttpErrors.Conflict(`Pincode ${pincode} is already mapped to ${riderLabel}.`);
    }
  }

  // ─── Create (fan a pincodes[] array out into individual rows) ─────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider_pincode_mapping:create']})
  @post('/rider-pincode-mappings')
  @response(200, {description: 'Pincodes mapped to a rider'})
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['riderId', 'pincodes'],
            properties: {
              riderId: {type: 'string', format: 'uuid'},
              pincodes: {type: 'array', minItems: 1, items: {type: 'string'}},
            },
          },
        },
      },
    })
    body: {riderId: string; pincodes: string[]},
  ): Promise<object> {
    await this.assertRiderActive(body.riderId);

    const pincodes = [...new Set(body.pincodes.map(p => String(p).trim()))];
    for (const pincode of pincodes) {
      this.assertPincodeFormat(pincode);
      await this.assertPincodeFree(pincode);
    }

    const {v4} = await import('uuid');
    const mappings = [];
    for (const pincode of pincodes) {
      mappings.push(await this.mappingRepository.create({id: v4(), riderId: body.riderId, pincode}));
    }
    return {message: 'Pincodes mapped.', mappings};
  }

  // ─── List ─────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider_pincode_mapping:read']})
  @get('/rider-pincode-mappings')
  @response(200, {description: 'Rider pincode mappings'})
  async find(
    @param.filter(RiderPincodeMapping) filter?: Filter<RiderPincodeMapping>,
  ): Promise<RiderPincodeMapping[]> {
    return this.mappingRepository.find({
      ...filter,
      where: {...filter?.where, isDeleted: false},
      include: [{relation: 'rider'}],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider_pincode_mapping:read']})
  @get('/rider-pincode-mappings/{id}')
  @response(200, {description: 'One pincode mapping'})
  async findById(@param.path.string('id') id: string): Promise<RiderPincodeMapping> {
    const mapping = await this.mappingRepository.findOne({
      where: {id, isDeleted: false},
      include: [{relation: 'rider'}],
    });
    if (!mapping) throw new HttpErrors.NotFound('Pincode mapping not found.');
    return mapping;
  }

  /** Rider-detail-panel view — the frontend's existing {riderId, pincodes} shape. */
  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider_pincode_mapping:read']})
  @get('/riders/{id}/pincodes')
  @response(200, {description: "A rider's covered pincodes"})
  async forRider(@param.path.string('id') riderId: string): Promise<object> {
    const mappings = await this.mappingRepository.find({
      where: {riderId, isActive: true, isDeleted: false} as object,
    });
    return {riderId, pincodes: mappings.map(m => m.pincode)};
  }

  // ─── Update ─────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider_pincode_mapping:update']})
  @patch('/rider-pincode-mappings/{id}')
  @response(200, {description: 'Pincode mapping updated'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              pincode: {type: 'string'},
              isActive: {type: 'boolean'},
            },
          },
        },
      },
    })
    body: {pincode?: string; isActive?: boolean},
  ): Promise<object> {
    const existing = await this.mappingRepository.findOne({where: {id, isDeleted: false}});
    if (!existing) throw new HttpErrors.NotFound('Pincode mapping not found.');

    if (body.pincode !== undefined && body.pincode !== existing.pincode) {
      this.assertPincodeFormat(body.pincode);
      await this.assertPincodeFree(body.pincode, id);
    }

    await this.mappingRepository.updateById(id, {
      ...(body.pincode !== undefined ? {pincode: body.pincode} : {}),
      ...(body.isActive !== undefined ? {isActive: body.isActive} : {}),
    });
    return {message: 'Pincode mapping updated.'};
  }

  // ─── Soft delete ────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider_pincode_mapping:delete']})
  @del('/rider-pincode-mappings/{id}')
  @response(200, {description: 'Pincode mapping deleted'})
  async deleteById(@param.path.string('id') id: string): Promise<object> {
    const existing = await this.mappingRepository.findOne({where: {id, isDeleted: false}});
    if (!existing) throw new HttpErrors.NotFound('Pincode mapping not found.');
    await this.mappingRepository.updateById(id, {
      isDeleted: true,
      deletedAt: new Date() as unknown as Date,
    });
    return {message: 'Pincode mapping deleted.'};
  }
}
