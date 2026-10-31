import {expect} from '@loopback/testlab';
import {RiderAuthController} from '../controllers/rider-auth.controller';

describe('rider OTP roles', () => {
  const phone = '9999999999';
  const countryCode = '+91';

  it('issues only rider authority for a shared account', async () => {
    let tokenProfile: {roles: string[]} | undefined;
    const controller = Object.assign(Object.create(RiderAuthController.prototype), {
      usersRepository: {
        findOne: async () => ({
          id: 'user-1', phone, countryCode, isActive: true,
          roles: [{value: 'rider'}, {value: 'super_admin'}],
          loginOtp: 'hash', loginOtpExpires: new Date(Date.now() + 60_000),
        }),
        updateById: async () => {},
      },
      riderRepository: {findOne: async () => ({id: 'rider-1', isActive: true})},
      hasher: {comparePassword: async () => true},
      jwtService: {generateToken: async (profile: {roles: string[]}) => {
        tokenProfile = profile;
        return 'token';
      }},
    }) as RiderAuthController;

    const result = await controller.verifyOtp({phone, countryCode, otp: '123456'}) as {
      token: string;
      user: {roles: string[]};
    };

    expect(tokenProfile?.roles).to.eql(['rider']);
    expect(result.token).to.equal('token');
    expect(result.user.roles).to.eql(['rider', 'super_admin']);
  });

  it('does not send rider OTP without an active rider role', async () => {
    const controller = Object.assign(Object.create(RiderAuthController.prototype), {
      usersRepository: {findOne: async () => ({
        id: 'user-1', phone, countryCode, isActive: true, roles: [{value: 'super_admin'}],
      })},
      riderRepository: {findOne: async () => ({id: 'rider-1', isActive: true})},
    }) as RiderAuthController;

    await expect(controller.sendOtp({phone, countryCode})).to.be.rejectedWith(/no active rider role/);
  });
});
