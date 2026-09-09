import { authenticate } from '@loopback/authentication';
import { inject } from '@loopback/core';
import { Filter, IsolationLevel, repository } from '@loopback/repository';
import { del, get, getModelSchemaRef, HttpErrors, param, patch, post, requestBody, response } from '@loopback/rest';
import { authorize } from '../authorization';
import { PresstoDataSource } from '../datasources';
import { Rider } from '../models';
import { RiderType } from '../models/rider-type.enum';
import {
  RiderRepository,
  RolesRepository,
  UserRolesRepository,
  UsersRepository,
} from '../repositories';
import { BcryptHasher } from '../services/hash.password.bcrypt';

// The role a rider's login account is created under. Its permission set is
// defined when the rider app is built; the account exists now so phone + OTP
// login has something to resolve.
const RIDER_ROLE_VALUE = 'rider';

export class RiderController {
  constructor(
    @repository(RiderRepository)
    private riderRepository: RiderRepository,
    @repository(UsersRepository)
    private usersRepository: UsersRepository,
    @repository(RolesRepository)
    private rolesRepository: RolesRepository,
    @repository(UserRolesRepository)
    private userRolesRepository: UserRolesRepository,
    @inject('datasources.pressto')
    private dataSource: PresstoDataSource,
    @inject('service.hasher')
    private hasher: BcryptHasher,
  ) { }

  private async riderSearchWhere(search?: string): Promise<object | undefined> {
    const query = String(search ?? '').trim();
    if (!query) return undefined;

    const digits = query.replace(/\D/g, '');
    const phoneQuery = digits.length >= 10 ? digits.slice(-10) : query;
    const matchingUsers = await this.usersRepository.find({
      where: {phone: {ilike: `%${phoneQuery}%`}} as object,
      fields: {id: true},
    });

    return {
      or: [
        {riderCode: {ilike: `%${query}%`}},
        {firstName: {ilike: `%${query}%`}},
        {lastName: {ilike: `%${query}%`}},
        {alternateNumber: {ilike: `%${phoneQuery}%`}},
        ...(matchingUsers.length ? [{userId: {inq: matchingUsers.map(user => user.id)}}] : []),
      ],
    };
  }

  private combineRiderWhere(where?: object, searchWhere?: object): object {
    const clauses = [{isDeleted: false}, ...(where ? [where] : []), ...(searchWhere ? [searchWhere] : [])];
    return clauses.length === 1 ? clauses[0] : {and: clauses};
  }

  /**
   * The `rider` role, creating it on first use if the seed has not run yet.
   * Self-healing so rider creation never depends on seed order; the role it
   * makes matches the seed definition, so a later seed is a no-op.
   */
  private async resolveRiderRole() {
    const existing = await this.rolesRepository.findOne({ where: { value: RIDER_ROLE_VALUE } });
    if (existing) return existing;
    return this.rolesRepository.create({
      value: RIDER_ROLE_VALUE,
      label: 'Rider',
      description: 'Rider app account — signs in by phone + OTP. No admin access.',
      isLocked: true,
      loginAccess: false,
      scope: 'store',
      isActive: true,
      isDeleted: false,
    });
  }

  /** RID001, RID002 … — next number above the highest existing code. */
  private async generateRiderCode(): Promise<string> {
    const riders = await this.riderRepository.find({ fields: { riderCode: true } });
    let maxNum = 0;
    for (const r of riders) {
      const match = r.riderCode?.match(/^RID(\d+)$/i);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
    return `RID${String(maxNum + 1).padStart(3, '0')}`;
  }

  private async generateUniqueUsername(email: string | undefined, fullName: string): Promise<string> {
    const base = email
      ? email.split('@')[0].toLowerCase()
      : fullName.trim().toLowerCase().replace(/\s+/g, '.');
    let username = base || 'rider';
    for (let attempt = 0; attempt < 10; attempt++) {
      const existing = await this.usersRepository.findOne({ where: { username } });
      if (!existing) return username;
      username = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
    }
    throw new HttpErrors.InternalServerError('Could not generate a unique username');
  }

  /** The user, if any, that already owns this phone/email. */
  private async findUserByContact(phone: string, email: string | undefined) {
    const orConditions: object[] = [{ phone }];
    if (email) orConditions.push({ email });
    return this.usersRepository.findOne({ where: { or: orConditions } });
  }

  /**
   * On EDIT: a phone/email must not collide with a *different* user. Editing a
   * rider's own account is fine, so ignore their own userId.
   */
  private async assertContactFree(phone: string, email: string | undefined, ignoreUserId: string) {
    const existing = await this.findUserByContact(phone, email);
    if (existing && existing.id !== ignoreUserId) {
      throw new HttpErrors.Conflict('That phone number or email is already in use.');
    }
  }

  // ─── Create ─────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'], permissions: ['rider:create'] })
  @post('/riders')
  @response(200, { description: 'Rider created' })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['riderType', 'firstName', 'lastName', 'phone', 'address'],
            properties: {
              riderType: { type: 'string', enum: Object.values(RiderType) },
              firstName: { type: 'string' },
              lastName: { type: 'string' },
              phone: { type: 'string', description: 'Login identity — 10 digits, unique' },
              countryCode: { type: 'string', default: '+91' },
              emailId: {
                type: 'string',
                anyOf: [{format: 'email'}, {maxLength: 0}],
                description: 'Optional; blank is accepted when no email is provided',
              },
              alternateNumber: { type: 'string' },
              address: { type: 'string' },
              doorFloorFlat: { type: 'string' },
              landmark: { type: 'string' },
            },
          },
        },
      },
    })
    body: {
      riderType: RiderType;
      firstName: string;
      lastName: string;
      phone: string;
      countryCode?: string;
      emailId?: string;
      alternateNumber?: string;
      address: string;
      doorFloorFlat?: string;
      landmark?: string;
    },
  ): Promise<object> {
    const role = await this.resolveRiderRole();

    // One person, one login, many roles. If this phone/email already belongs to
    // someone — a customer who is now also a rider — reuse that account and add
    // the rider role on top, rather than refusing the number. Only a genuine
    // second rider profile on the same person is rejected.
    const existingUser = await this.findUserByContact(body.phone, body.emailId);
    if (existingUser) {
      const alreadyRider = await this.riderRepository.findOne({
        where: { userId: existingUser.id, isDeleted: false },
      });
      if (alreadyRider) {
        throw new HttpErrors.Conflict(
          `That phone or email already belongs to rider ${alreadyRider.riderCode}.`,
        );
      }
    }

    const fullName = `${body.firstName} ${body.lastName}`.trim();
    const riderCode = await this.generateRiderCode();

    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      // Reuse the existing login when the person is already in the system — and
      // leave their password alone, since it is the credential they already use.
      const user = existingUser
        ? existingUser
        : await this.usersRepository.create(
          {
            fullName,
            username: await this.generateUniqueUsername(body.emailId, fullName),
            ...(body.emailId && { email: body.emailId }),
            countryCode: body.countryCode?.trim() ? body.countryCode.trim() : '+91',
            phone: body.phone,
            // Signs in by OTP, never by password — so this is a throwaway.
            password: await this.hasher.hashPassword(
              `Rider@${Math.floor(100000 + Math.random() * 900000)}`,
            ),
            isActive: true,
          },
          { transaction: tx },
        );

      // Add the rider role only if this (possibly existing) user lacks it —
      // adding it twice would leave a duplicate user_roles row.
      const hasRole = existingUser
        ? await this.userRolesRepository.findOne({
          where: {
            and: [
              { usersId: user.id },
              { rolesId: role.id }
            ]
          },
        })
        : null;
      if (!hasRole) {
        await this.userRolesRepository.create(
          { usersId: user.id, rolesId: role.id },
          { transaction: tx },
        );
      }

      const rider = await this.riderRepository.create(
        {
          userId: user.id,
          riderCode,
          riderType: body.riderType,
          firstName: body.firstName,
          lastName: body.lastName,
          alternateNumber: body.alternateNumber,
          address: body.address,
          doorFloorFlat: body.doorFloorFlat,
          landmark: body.landmark,
          isActive: true,
        },
        { transaction: tx },
      );

      await tx.commit();

      return {
        message: 'Rider created successfully',
        rider: { ...rider, user: { ...user, password: undefined } },
      };
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  // ─── List ─────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'], permissions: ['rider:read'] })
  @get('/riders')
  @response(200, { description: 'Array of riders with their login account' })
  async find(
    @param.filter(Rider) filter?: Filter<Rider>,
    @param.query.string('search') search?: string,
  ): Promise<Rider[]> {
    // Soft-deleted riders are never listed; the login account is included so the
    // UI has phone/email/name without a second call.
    const searchWhere = await this.riderSearchWhere(search);
    return this.riderRepository.find({
      ...filter,
      where: this.combineRiderWhere(filter?.where as object | undefined, searchWhere),
      include: [{ relation: 'user' }],
    });
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'], permissions: ['rider:read'] })
  @get('/riders/count')
  @response(200, { description: 'Rider count' })
  async count(
    @param.query.object('where') where?: object,
    @param.query.string('search') search?: string,
  ): Promise<{ count: number }> {
    const searchWhere = await this.riderSearchWhere(search);
    return this.riderRepository.count(this.combineRiderWhere(where, searchWhere));
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'], permissions: ['rider:read'] })
  @get('/riders/{id}')
  @response(200, {
    description: 'Rider with login account',
    content: { 'application/json': { schema: getModelSchemaRef(Rider, { includeRelations: true }) } },
  })
  async findById(@param.path.string('id') id: string): Promise<Rider> {
    const rider = await this.riderRepository.findOne({
      where: { id, isDeleted: false },
      include: [{ relation: 'user' }],
    });
    if (!rider) throw new HttpErrors.NotFound('Rider not found.');
    return rider;
  }

  // ─── Update ─────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'], permissions: ['rider:update'] })
  @patch('/riders/{id}')
  @response(200, { description: 'Rider updated' })
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              // riderCode is immutable — deliberately not accepted.
              riderType: { type: 'string', enum: Object.values(RiderType) },
              firstName: { type: 'string' },
              lastName: { type: 'string' },
              phone: { type: 'string' },
              countryCode: { type: 'string' },
              emailId: {
                type: 'string',
                anyOf: [{format: 'email'}, {maxLength: 0}],
                description: 'Optional; blank is accepted when no email is provided',
              },
              alternateNumber: { type: 'string' },
              address: { type: 'string' },
              doorFloorFlat: { type: 'string' },
              landmark: { type: 'string' },
              // Activate/deactivate goes through this same endpoint. Deletion is
              // separate (DELETE /riders/{id}) so it needs the rider:delete
              // permission rather than rider:update.
              isActive: { type: 'boolean' },
            },
          },
        },
      },
    })
    body: {
      riderType?: RiderType;
      firstName?: string;
      lastName?: string;
      phone?: string;
      countryCode?: string;
      emailId?: string;
      alternateNumber?: string;
      address?: string;
      doorFloorFlat?: string;
      landmark?: string;
      isActive?: boolean;
    },
  ): Promise<object> {
    const rider = await this.riderRepository.findOne({ where: { id, isDeleted: false } });
    if (!rider) throw new HttpErrors.NotFound('Rider not found.');

    const role = await this.resolveRiderRole();

    // Phone/email live on the account. Re-check uniqueness only when they change.
    const account = await this.usersRepository.findById(rider.userId);
    const phoneChanged = body.phone !== undefined && body.phone !== account.phone;
    const emailChanged = body.emailId !== undefined && body.emailId !== account.email;
    if (phoneChanged || emailChanged) {
      await this.assertContactFree(
        body.phone ?? account.phone,
        body.emailId ?? account.email,
        rider.userId,
      );
    }

    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      const userFields: Record<string, unknown> = {};
      if (body.phone !== undefined) userFields.phone = body.phone;
      if (body.countryCode !== undefined) userFields.countryCode = body.countryCode;
      if (body.emailId !== undefined) userFields.email = body.emailId;
      if (body.firstName !== undefined || body.lastName !== undefined) {
        const first = body.firstName ?? rider.firstName;
        const last = body.lastName ?? rider.lastName;
        userFields.fullName = `${first} ${last}`.trim();
      }
      // Keep the account's active flag in step — an inactive rider can't log in.
      if (body.isActive !== undefined) userFields.isActive = body.isActive;
      if (Object.keys(userFields).length) {
        await this.usersRepository.updateById(rider.userId, userFields, { transaction: tx });
      }

      const riderFields: Record<string, unknown> = {};
      for (const key of ['riderType', 'firstName', 'lastName', 'alternateNumber', 'address', 'doorFloorFlat', 'landmark'] as const) {
        if (body[key] !== undefined) riderFields[key] = body[key];
      }
      if (body.isActive !== undefined) riderFields.isActive = body.isActive;
      if (Object.keys(riderFields).length) {
        await this.riderRepository.updateById(id, riderFields, { transaction: tx });
      }

      const hasRole = await this.userRolesRepository.findOne({
        where: {
          and: [
            { usersId: account.id },
            { rolesId: role.id }
          ]
        }
      }, { transaction: tx });

      if(!hasRole){
        await this.userRolesRepository.create(
          { usersId: account.id, rolesId: role.id },
          { transaction: tx },
        );
      }

      await tx.commit();
      return { message: 'Rider updated successfully' };
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  // ─── Soft delete ────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'], permissions: ['rider:delete'] })
  @del('/riders/{id}')
  @response(200, { description: 'Rider soft-deleted' })
  async deleteById(@param.path.string('id') id: string): Promise<object> {
    const rider = await this.riderRepository.findOne({ where: { id, isDeleted: false } });
    if (!rider) throw new HttpErrors.NotFound('Rider not found.');

    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      await this.riderRepository.updateById(
        id,
        { isDeleted: true, isActive: false, deletedAt: new Date() as unknown as Date },
        { transaction: tx },
      );
      // Block the login too — a deleted rider must not be able to sign in.
      await this.usersRepository.updateById(rider.userId, { isActive: false }, { transaction: tx });
      await tx.commit();
      return { message: 'Rider deleted.' };
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
}
