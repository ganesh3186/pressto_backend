import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors, post, requestBody, response} from '@loopback/rest';
import {securityId} from '@loopback/security';
import {RiderRepository, UsersRepository} from '../repositories';
import {BcryptHasher} from '../services/hash.password.bcrypt';
import {JWTService} from '../services/jwt-service';

// How long a login OTP stays valid, in minutes.
const OTP_TTL_MINUTES = 10;

/**
 * Rider app authentication — phone + OTP.
 *
 * Riders are created from the admin panel (RiderController); they never register
 * here and never use a password. The flow is: enter phone → send-otp →
 * verify-otp → JWT + rider detail, and the app session begins.
 *
 * Mirrors CustomerAuthController's OTP flow, scoped to riders: only a user who
 * has an active, non-deleted rider profile can sign in on the rider app.
 */
export class RiderAuthController {
  constructor(
    @repository(UsersRepository)
    private usersRepository: UsersRepository,
    @repository(RiderRepository)
    private riderRepository: RiderRepository,
    @inject('service.hasher')
    private hasher: BcryptHasher,
    @inject('service.jwt.service')
    private jwtService: JWTService,
  ) {}

  /**
   * The user + their rider profile for this phone, or a clear error. Blocks a
   * user who is not a rider, whose rider record is deleted, or whose account is
   * inactive (deactivating/deleting a rider flips Users.isActive).
   */
  private async resolveActiveRider(phone: string, countryCode: string) {
    const user = await this.usersRepository.findOne({
      where: {phone, countryCode},
      include: [{relation: 'roles'}],
    });
    if (!user) {
      throw new HttpErrors.BadRequest('No account found for this phone number.');
    }

    const rider = await this.riderRepository.findOne({
      where: {userId: user.id, isDeleted: false},
    });
    if (!rider) {
      throw new HttpErrors.Forbidden('This number is not registered as a rider.');
    }

    if (user.isActive === false || rider.isActive === false) {
      throw new HttpErrors.Forbidden('This rider account is inactive. Contact the store.');
    }

    return {user, rider};
  }

  // ─── Send OTP ─────────────────────────────────────────────────────────────

  @post('/auth/rider/send-otp')
  @response(200, {description: 'OTP sent to the rider'})
  async sendOtp(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['phone', 'countryCode'],
            properties: {
              phone: {type: 'string'},
              countryCode: {type: 'string', default: '+91'},
            },
          },
        },
      },
    })
    body: {phone: string; countryCode: string},
  ): Promise<object> {
    const {user} = await this.resolveActiveRider(body.phone, body.countryCode);

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOtp = await this.hasher.hashPassword(otp);

    const expiry = new Date();
    expiry.setMinutes(expiry.getMinutes() + OTP_TTL_MINUTES);

    await this.usersRepository.updateById(user.id, {
      loginOtp: hashedOtp,
      loginOtpExpires: expiry,
    });

    // TODO: send via SMS in production. Returned here so the app team can
    // integrate now — same as the customer OTP flow.
    return {message: 'OTP sent', otp};
  }

  // ─── Verify OTP ───────────────────────────────────────────────────────────

  @post('/auth/rider/verify-otp')
  @response(200, {description: 'OTP verified — JWT and rider detail returned'})
  async verifyOtp(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['phone', 'countryCode', 'otp'],
            properties: {
              phone: {type: 'string'},
              countryCode: {type: 'string', default: '+91'},
              otp: {type: 'string'},
            },
          },
        },
      },
    })
    body: {phone: string; countryCode: string; otp: string},
  ): Promise<object> {
    const {user, rider} = await this.resolveActiveRider(body.phone, body.countryCode);

    if (!user.loginOtp || !user.loginOtpExpires) {
      throw new HttpErrors.BadRequest('No OTP requested. Please request an OTP first.');
    }
    if (new Date() > new Date(user.loginOtpExpires)) {
      throw new HttpErrors.BadRequest('OTP has expired. Please request a new one.');
    }
    const isOtpValid = await this.hasher.comparePassword(body.otp, user.loginOtp);
    if (!isOtpValid) {
      throw new HttpErrors.BadRequest('Invalid OTP.');
    }

    // Single-use — clear it so the same OTP can't be replayed.
    await this.usersRepository.updateById(user.id, {
      loginOtp: undefined,
      loginOtpExpires: undefined,
    });

    const roles = (user.roles ?? []).map((r: {value: string}) => r.value);
    const userProfile = {
      [securityId]: user.id!,
      id: user.id!,
      email: user.email,
      phone: user.phone,
      roles,
    };
    const token = await this.jwtService.generateToken(userProfile as never);

    return {
      token,
      rider: {
        id: rider.id,
        riderCode: rider.riderCode,
        riderType: rider.riderType,
        firstName: rider.firstName,
        lastName: rider.lastName,
        alternateNumber: rider.alternateNumber,
        address: rider.address,
        doorFloorFlat: rider.doorFloorFlat,
        landmark: rider.landmark,
      },
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        countryCode: user.countryCode,
        roles,
      },
    };
  }
}
