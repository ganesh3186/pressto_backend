import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {Filter, repository} from '@loopback/repository';
import {del, get, HttpErrors, param, patch, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {Coupon, CouponDiscountType} from '../models';
import {
  CouponCustomerRepository,
  CouponRedemptionRepository,
  CouponRepository,
  CustomerRepository,
  UsersRepository,
} from '../repositories';
import {CouponService} from '../services/coupon.service';

interface CouponBody {
  code: string;
  name: string;
  description?: string;
  colorTag?: string;
  discountType: CouponDiscountType;
  discountValue: number;
  maxDiscountAmount?: number;
  startDate: string;
  endDate: string;
  maxUsesPerCustomer?: number;
  maxUsesTotal?: number;
  serviceCategoryIds?: string[];
  serviceIds?: string[];
  itemCategoryIds?: string[];
  itemIds?: string[];
  regionIds?: string[];
  clusterIds?: string[];
  storeIds?: string[];
  customerLabelIds?: string[];
  isActive?: boolean;
}

export class CouponController {
  constructor(
    @repository(CouponRepository) private couponRepository: CouponRepository,
    @repository(CouponCustomerRepository) private couponCustomerRepository: CouponCustomerRepository,
    @repository(CouponRedemptionRepository) private couponRedemptionRepository: CouponRedemptionRepository,
    @repository(CustomerRepository) private customerRepository: CustomerRepository,
    @repository(UsersRepository) private usersRepository: UsersRepository,
    @inject('services.coupon') private couponService: CouponService,
  ) {}

  // ─── Create ─────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['coupon:create']})
  @post('/coupons')
  @response(200, {description: 'Coupon created'})
  async create(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody() body: CouponBody,
  ): Promise<object> {
    const code = body.code.trim().toUpperCase();
    if (!code) throw new HttpErrors.BadRequest('Coupon code is required.');
    const existing = await this.couponRepository.findOne({where: {code} as object});
    if (existing) throw new HttpErrors.Conflict(`Coupon code ${code} already exists.`);

    const {v4} = await import('uuid');
    const coupon = await this.couponRepository.create({
      id: v4(),
      ...body,
      code,
      createdBy: currentUser[securityId],
      updatedBy: currentUser[securityId],
    });
    return {message: 'Coupon created.', coupon};
  }

  // ─── List ─────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['coupon:read']})
  @get('/coupons')
  @response(200, {description: 'Coupons'})
  async find(@param.filter(Coupon) filter?: Filter<Coupon>): Promise<Coupon[]> {
    return this.couponRepository.find({
      ...filter,
      where: {...filter?.where, isDeleted: false},
      order: filter?.order ?? ['createdAt DESC'],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['coupon:read']})
  @get('/coupons/count')
  @response(200, {description: 'Coupon count'})
  async count(@param.query.object('where') where?: object): Promise<{count: number}> {
    return this.couponRepository.count({...where, isDeleted: false} as object);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['coupon:read']})
  @get('/coupons/{id}')
  @response(200, {description: 'Coupon detail'})
  async findById(@param.path.string('id') id: string): Promise<Coupon> {
    const coupon = await this.couponRepository.findOne({where: {id, isDeleted: false}});
    if (!coupon) throw new HttpErrors.NotFound('Coupon not found.');
    return coupon;
  }

  // ─── Update ─────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['coupon:update']})
  @patch('/coupons/{id}')
  @response(200, {description: 'Coupon updated'})
  async updateById(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody() body: Partial<CouponBody>,
  ): Promise<object> {
    const existing = await this.couponRepository.findOne({where: {id, isDeleted: false}});
    if (!existing) throw new HttpErrors.NotFound('Coupon not found.');

    if (body.code !== undefined) {
      const newCode = body.code.trim().toUpperCase();
      if (newCode !== existing.code) {
        const redeemed = await this.couponRedemptionRepository.count({couponId: id} as object);
        if (redeemed.count > 0) {
          throw new HttpErrors.Conflict('Cannot change the code of a coupon that has already been redeemed.');
        }
        const clash = await this.couponRepository.findOne({where: {code: newCode} as object});
        if (clash) throw new HttpErrors.Conflict(`Coupon code ${newCode} already exists.`);
      }
      body.code = newCode;
    }

    await this.couponRepository.updateById(id, {...body, updatedBy: currentUser[securityId]});
    return {message: 'Coupon updated.'};
  }

  // ─── Soft delete ────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['coupon:delete']})
  @del('/coupons/{id}')
  @response(200, {description: 'Coupon deleted'})
  async deleteById(@param.path.string('id') id: string): Promise<object> {
    const existing = await this.couponRepository.findOne({where: {id, isDeleted: false}});
    if (!existing) throw new HttpErrors.NotFound('Coupon not found.');
    await this.couponRepository.updateById(id, {isDeleted: true, deletedAt: new Date()});
    return {message: 'Coupon deleted.'};
  }

  // ─── Individually-targeted customers ───────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['coupon:read']})
  @get('/coupons/{id}/customers')
  @response(200, {description: 'Individually-targeted customers for this coupon'})
  async listCustomers(@param.path.string('id') id: string): Promise<object> {
    const grants = await this.couponCustomerRepository.find({
      where: {couponId: id, isDeleted: false} as object,
      order: ['createdAt DESC'],
    });
    const customerIds = grants.map(g => g.customerId);
    const customers = customerIds.length
      ? await this.customerRepository.find({where: {id: {inq: customerIds}} as object})
      : [];
    const customerById = new Map(customers.map(c => [c.id, c]));
    const userIds = customers.map(c => c.userId);
    const users = userIds.length
      ? await this.usersRepository.find({where: {id: {inq: userIds}} as object, fields: {id: true, phone: true} as object})
      : [];
    const userById = new Map(users.map(u => [u.id, u]));

    const customersOut = grants.map(g => {
      const customer = customerById.get(g.customerId);
      return {
        grantId: g.id,
        customerId: g.customerId,
        firstName: customer?.firstName ?? '',
        lastName: customer?.lastName ?? '',
        mobile: customer ? userById.get(customer.userId)?.phone ?? '' : '',
        source: g.source,
        addedAt: g.createdAt,
      };
    });
    return {customers: customersOut};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['coupon:update']})
  @post('/coupons/{id}/customers')
  @response(200, {description: 'Individual customers added to this coupon'})
  async addCustomers(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['customerIds'],
            properties: {
              customerIds: {type: 'array', items: {type: 'string', format: 'uuid'}},
              source: {type: 'string', enum: ['manual', 'csv_upload']},
            },
          },
        },
      },
    })
    body: {customerIds: string[]; source?: 'manual' | 'csv_upload'},
  ): Promise<object> {
    const coupon = await this.couponRepository.findOne({where: {id, isDeleted: false}});
    if (!coupon) throw new HttpErrors.NotFound('Coupon not found.');

    const uniqueIds = [...new Set(body.customerIds)];
    const customers = await this.customerRepository.find({
      where: {id: {inq: uniqueIds}, isDeleted: false} as object,
      fields: {id: true} as object,
    });
    const foundIds = new Set(customers.map(c => c.id));
    const notFound = uniqueIds.filter(cid => !foundIds.has(cid));

    const existingGrants = await this.couponCustomerRepository.find({
      where: {couponId: id, customerId: {inq: [...foundIds]}, isDeleted: false} as object,
      fields: {customerId: true} as object,
    });
    const alreadyGranted = new Set(existingGrants.map(g => g.customerId));

    const toAdd = [...foundIds].filter(cid => !alreadyGranted.has(cid));
    const {v4} = await import('uuid');
    for (const customerId of toAdd) {
      await this.couponCustomerRepository.create({
        id: v4(),
        couponId: id,
        customerId,
        source: body.source ?? 'manual',
      });
    }

    return {
      message: `${toAdd.length} customer(s) added.`,
      added: toAdd.length,
      skipped: alreadyGranted.size,
      notFound: notFound.length,
    };
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['coupon:update']})
  @del('/coupons/{id}/customers/{customerId}')
  @response(200, {description: 'Customer removed from this coupon'})
  async removeCustomer(
    @param.path.string('id') id: string,
    @param.path.string('customerId') customerId: string,
  ): Promise<object> {
    const grant = await this.couponCustomerRepository.findOne({
      where: {couponId: id, customerId, isDeleted: false} as object,
    });
    if (!grant) throw new HttpErrors.NotFound('This customer is not individually targeted by this coupon.');
    await this.couponCustomerRepository.updateById(grant.id, {isDeleted: true, deletedAt: new Date()});
    return {message: 'Customer removed from coupon.'};
  }

  // ─── Redemption history ─────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['coupon:read']})
  @get('/coupons/{id}/redemptions')
  @response(200, {description: 'Redemption history for this coupon'})
  async redemptions(@param.path.string('id') id: string): Promise<object> {
    const coupon = await this.couponRepository.findOne({where: {id, isDeleted: false}});
    if (!coupon) throw new HttpErrors.NotFound('Coupon not found.');

    const rows = await this.couponRedemptionRepository.find({
      where: {couponId: id} as object,
      order: ['createdAt DESC'],
    });
    const customerIds = [...new Set(rows.map(r => r.customerId))];
    const customers = customerIds.length
      ? await this.customerRepository.find({where: {id: {inq: customerIds}} as object})
      : [];
    const customerById = new Map(customers.map(c => [c.id, c]));

    const redemptionsOut = rows.map(r => ({
      id: r.id,
      customerId: r.customerId,
      customerName: customerById.get(r.customerId)
        ? `${customerById.get(r.customerId)!.firstName} ${customerById.get(r.customerId)!.lastName}`
        : 'Customer',
      orderId: r.orderId,
      discountAmount: r.discountAmount,
      isReversed: r.isReversed,
      redeemedAt: r.createdAt,
    }));

    return {
      redemptions: redemptionsOut,
      summary: {
        totalUsesCount: coupon.totalUsesCount ?? 0,
        remainingTotalUses:
          coupon.maxUsesTotal != null ? Math.max(0, coupon.maxUsesTotal - (coupon.totalUsesCount ?? 0)) : null,
        uniqueCustomersUsed: new Set(rows.filter(r => !r.isReversed).map(r => r.customerId)).size,
      },
    };
  }

  // ─── Validate (live preview, also used internally by OrderService) ────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['coupon:read']})
  @post('/coupons/validate')
  @response(200, {description: 'Coupon eligibility + discount preview'})
  async validate(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['couponCode', 'customerId', 'storeId', 'items'],
            properties: {
              couponCode: {type: 'string'},
              customerId: {type: 'string', format: 'uuid'},
              storeId: {type: 'string', format: 'uuid'},
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['serviceId', 'itemId', 'quantity', 'totalPrice'],
                  properties: {
                    serviceId: {type: 'string'},
                    itemId: {type: 'string'},
                    quantity: {type: 'number'},
                    totalPrice: {type: 'number'},
                  },
                },
              },
            },
          },
        },
      },
    })
    body: {
      couponCode: string;
      customerId: string;
      storeId: string;
      items: {serviceId: string; itemId: string; quantity: number; totalPrice: number}[];
    },
  ): Promise<object> {
    return this.couponService.evaluate(body);
  }
}
