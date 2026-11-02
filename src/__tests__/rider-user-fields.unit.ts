import {expect} from '@loopback/testlab';
import {DefaultCrudRepository, juggler} from '@loopback/repository';
import {RiderController} from '../controllers/rider.controller';
import {Rider, Users} from '../models';
import {RiderType} from '../models/rider-type.enum';

const SECRET_FIELDS = [
  'password',
  'loginOtp',
  'loginOtpExpires',
  'resetPasswordOtp',
  'resetPasswordOtpExpires',
];

type Include = {relation: string; scope?: {fields?: Record<string, boolean>}};

describe('rider responses hide login secrets', () => {
  function controllerCapturingIncludes(captured: Include[][]) {
    return Object.assign(Object.create(RiderController.prototype), {
      riderRepository: {
        find: async (filter: {include: Include[]}) => {
          captured.push(filter.include);
          return [];
        },
        findOne: async (filter: {include: Include[]}) => {
          captured.push(filter.include);
          return {id: 'rider-1'};
        },
      },
    }) as RiderController;
  }

  function expectSafeUserInclude(include: Include[]) {
    const user = include.find(item => item.relation === 'user');
    expect(user?.scope?.fields).to.eql({
      id: true,
      fullName: true,
      email: true,
      countryCode: true,
      phone: true,
      username: true,
      isActive: true,
    });
  }

  it('GET /riders limits the included login account fields', async () => {
    const captured: Include[][] = [];
    await controllerCapturingIncludes(captured).find();
    expectSafeUserInclude(captured[0]);
  });

  it('GET /riders ignores an include sent by the caller', async () => {
    const captured: Include[][] = [];
    await controllerCapturingIncludes(captured).find({
      include: [{relation: 'user'}],
    });
    expect(captured[0]).to.have.length(1);
    expectSafeUserInclude(captured[0]);
  });

  it('GET /riders/{id} limits the included login account fields', async () => {
    const captured: Include[][] = [];
    await controllerCapturingIncludes(captured).findById('rider-1');
    expectSafeUserInclude(captured[0]);
  });

  it('POST /riders does not return secrets from a reused account', async () => {
    const existingUser = {
      id: 'user-1',
      fullName: 'Old Name',
      username: 'old.name',
      email: 'old@example.com',
      countryCode: '+91',
      phone: '9999999999',
      isActive: true,
      password: 'password-hash',
      loginOtp: 'otp-hash',
      loginOtpExpires: new Date(),
      resetPasswordOtp: 'reset-hash',
      resetPasswordOtpExpires: new Date(),
    };
    const controller = Object.assign(Object.create(RiderController.prototype), {
      rolesRepository: {findOne: async () => ({id: 'role-1'})},
      usersRepository: {
        findOne: async () => existingUser,
        findById: async () => ({roles: [{value: 'customer'}]}),
        updateById: async () => {},
      },
      riderRepository: {
        findOne: async () => null,
        find: async () => [],
        create: async (data: object) => ({id: 'rider-1', ...data}),
      },
      userRolesRepository: {findOne: async () => ({id: 'assignment-1'}), create: async () => {}},
      customerRepository: {findOne: async () => ({isActive: true})},
      dataSource: {beginTransaction: async () => ({
        commit: async () => {},
        rollback: async () => {},
      })},
    }) as RiderController;

    const result = await controller.create({
      riderType: RiderType.RIDER,
      firstName: 'New',
      lastName: 'Name',
      phone: existingUser.phone,
      address: 'Mumbai',
    }) as {rider: {user: Record<string, unknown>}};

    for (const field of SECRET_FIELDS) {
      expect(result.rider.user).to.not.have.property(field);
    }
    expect(result.rider.user).to.containEql({
      id: 'user-1',
      phone: existingUser.phone,
      countryCode: '+91',
      email: existingUser.email,
    });
  });
});

// Runs the real repository include path against an in-memory database, so this
// proves LoopBack strips the fields rather than only that the scope was passed.
describe('rider include scope against a real repository', () => {
  it('leaves secrets out of the included user', async () => {
    const dataSource = new juggler.DataSource({name: 'memory', connector: 'memory'});

    class UsersRepo extends DefaultCrudRepository<Users, typeof Users.prototype.id> {
      constructor() {
        super(Users, dataSource);
      }
    }
    class RiderRepo extends DefaultCrudRepository<Rider, typeof Rider.prototype.id> {
      constructor(usersRepo: UsersRepo) {
        super(Rider, dataSource);
        const user = this.createBelongsToAccessorFor('user', async () => usersRepo);
        this.registerInclusionResolver('user', user.inclusionResolver);
      }
    }

    const usersRepo = new UsersRepo();
    const riderRepo = new RiderRepo(usersRepo);
    await usersRepo.create({
      id: 'user-1',
      fullName: 'Test Rider',
      username: 'test.rider',
      email: 'rider@example.com',
      countryCode: '+91',
      phone: '9999999999',
      password: 'password-hash',
      loginOtp: 'otp-hash',
      resetPasswordOtp: 'reset-hash',
    });
    await riderRepo.create({
      id: 'rider-1',
      userId: 'user-1',
      riderCode: 'RID001',
      riderType: RiderType.RIDER,
      firstName: 'Test',
      lastName: 'Rider',
      address: 'Mumbai',
    });

    const controller = Object.assign(Object.create(RiderController.prototype), {
      riderRepository: riderRepo,
    }) as RiderController;
    const rider = await controller.findById('rider-1');
    const user = rider.toJSON() as {user: Record<string, unknown>};

    for (const field of SECRET_FIELDS) {
      expect(user.user[field]).to.be.undefined();
    }
    expect(user.user).to.containEql({phone: '9999999999', fullName: 'Test Rider'});
  });
});
