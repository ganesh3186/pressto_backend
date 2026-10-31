import {expect} from '@loopback/testlab';
import {RiderController} from '../controllers/rider.controller';
import {RiderType} from '../models/rider-type.enum';

describe('rider creation', () => {
  const input = {
    riderType: RiderType.RIDER,
    firstName: 'New',
    lastName: 'Name',
    phone: '9999999999',
    address: 'Mumbai',
  };

  it('restores a deleted rider for the same login instead of inserting a duplicate', async () => {
    let riderUpdate: object | undefined;
    let userUpdate: object | undefined;
    let mappingUpdate: object | undefined;
    let created = false;
    let committed = false;
    const controller = Object.assign(Object.create(RiderController.prototype), {
      rolesRepository: {findOne: async () => ({id: 'role-1'})},
      usersRepository: {
        findOne: async () => ({id: 'user-1', phone: input.phone, countryCode: '+91', isActive: false}),
        findById: async () => ({roles: [{value: 'rider'}]}),
        updateById: async (_id: string, data: object) => {userUpdate = data;},
      },
      riderRepository: {
        findOne: async () => ({
          id: 'rider-1', userId: 'user-1', riderCode: 'RID001', isDeleted: true,
        }),
        updateById: async (_id: string, data: object) => {riderUpdate = data;},
        create: async () => {created = true;},
      },
      userRolesRepository: {findOne: async () => ({id: 'assignment-1'})},
      riderPincodeMappingRepository: {
        updateAll: async (data: object) => {mappingUpdate = data;},
      },
      dataSource: {beginTransaction: async () => ({
        commit: async () => {committed = true;},
        rollback: async () => {},
      })},
    }) as RiderController;

    const result = await controller.create(input) as {
      rider: {id: string; riderCode: string; user: {fullName: string; email: string | null}};
    };

    expect(riderUpdate).to.containEql({isDeleted: false, isActive: true});
    expect(userUpdate).to.eql({fullName: 'New Name', email: null, isActive: true});
    expect(mappingUpdate).to.containEql({isDeleted: true, isActive: false});
    expect(created).to.equal(false);
    expect(committed).to.equal(true);
    expect(result.rider).to.containEql({id: 'rider-1', riderCode: 'RID001'});
    expect(result.rider.user).to.containEql({fullName: 'New Name', email: null});
  });

  it('still rejects a rider whose profile is active', async () => {
    const controller = Object.assign(Object.create(RiderController.prototype), {
      rolesRepository: {findOne: async () => ({id: 'role-1'})},
      usersRepository: {findOne: async () => ({id: 'user-1', phone: input.phone, countryCode: '+91'})},
      riderRepository: {findOne: async () => ({riderCode: 'RID001', isDeleted: false})},
    }) as RiderController;

    await expect(controller.create(input)).to.be.rejectedWith(/already belongs to rider RID001/);
  });

  it('rejects an email match on a different phone before restoring a rider', async () => {
    const controller = Object.assign(Object.create(RiderController.prototype), {
      rolesRepository: {findOne: async () => ({id: 'role-1'})},
      usersRepository: {findOne: async ({where}: {where: {phone?: string}}) =>
        where.phone ? null : {id: 'user-1', phone: '8888888888', countryCode: '+91'}},
    }) as RiderController;

    await expect(controller.create({...input, emailId: 'rider@example.com'}))
      .to.be.rejectedWith(/different phone number/);
  });

  it('rejects contacts belonging to two accounts', async () => {
    const controller = Object.assign(Object.create(RiderController.prototype), {
      rolesRepository: {findOne: async () => ({id: 'role-1'})},
      usersRepository: {findOne: async ({where}: {where: {phone?: string}}) =>
        where.phone
          ? {id: 'phone-owner', phone: input.phone, countryCode: '+91'}
          : {id: 'email-owner', phone: '8888888888', countryCode: '+91'}},
    }) as RiderController;

    await expect(controller.create({...input, emailId: 'rider@example.com'}))
      .to.be.rejectedWith(/different accounts/);
  });

  for (const deleted of [false, true]) {
    it(`rejects a protected account when its rider profile is ${deleted ? 'deleted' : 'absent'}`, async () => {
      const controller = Object.assign(Object.create(RiderController.prototype), {
        rolesRepository: {findOne: async () => ({id: 'role-1'})},
        usersRepository: {
          findOne: async () => ({id: 'user-1', phone: input.phone, countryCode: '+91', isActive: true}),
          findById: async () => ({roles: [{value: 'super_admin'}]}),
        },
        riderRepository: {findOne: async () => deleted
          ? {id: 'rider-1', riderCode: 'RID001', isDeleted: true}
          : null},
      }) as RiderController;

      await expect(controller.create(input)).to.be.rejectedWith(/protected system account/);
    });
  }

  it('saves a changed email on a rider-only login', async () => {
    let userUpdate: object | undefined;
    const account = {
      id: 'user-1', phone: input.phone, countryCode: '+91', email: 'old@example.com', isActive: true,
    };
    const controller = Object.assign(Object.create(RiderController.prototype), {
      rolesRepository: {findOne: async () => ({id: 'role-1'})},
      usersRepository: {
        findOne: async ({where}: {where: {phone?: string}}) => where.phone ? account : null,
        findById: async () => ({roles: [{value: 'rider'}]}),
        updateById: async (_id: string, data: object) => {userUpdate = data;},
      },
      riderRepository: {
        findOne: async () => ({id: 'rider-1', riderCode: 'RID001', isDeleted: true}),
        updateById: async () => {},
      },
      riderPincodeMappingRepository: {updateAll: async () => {}},
      userRolesRepository: {findOne: async () => ({id: 'assignment-1'})},
      dataSource: {beginTransaction: async () => ({commit: async () => {}, rollback: async () => {}})},
    }) as RiderController;

    const result = await controller.create({...input, emailId: 'new@example.com'}) as {
      rider: {user: {email: string}};
    };

    expect(userUpdate).to.eql({fullName: 'New Name', email: 'new@example.com'});
    expect(result.rider.user.email).to.equal('new@example.com');
  });

  it('does not reactivate a disabled login shared with an employee', async () => {
    const controller = Object.assign(Object.create(RiderController.prototype), {
      rolesRepository: {findOne: async () => ({id: 'role-1'})},
      usersRepository: {
        findOne: async () => ({id: 'user-1', phone: input.phone, countryCode: '+91', isActive: false}),
        findById: async () => ({roles: [{value: 'rider'}, {value: 'store_manager'}]}),
      },
      employeeRepository: {findOne: async () => ({isActive: false})},
      riderRepository: {findOne: async () => ({id: 'rider-1', riderCode: 'RID001', isDeleted: true})},
    }) as RiderController;

    await expect(controller.create(input)).to.be.rejectedWith(/shared account is inactive/);
  });

  it('does not change the email on a shared login', async () => {
    const controller = Object.assign(Object.create(RiderController.prototype), {
      rolesRepository: {findOne: async () => ({id: 'role-1'})},
      usersRepository: {
        findOne: async ({where}: {where: {phone?: string}}) => where.phone
          ? {id: 'user-1', phone: input.phone, countryCode: '+91', email: 'old@example.com'}
          : null,
        findById: async () => ({roles: [{value: 'rider'}, {value: 'customer'}]}),
      },
      riderRepository: {findOne: async () => ({id: 'rider-1', riderCode: 'RID001', isDeleted: true})},
    }) as RiderController;

    await expect(controller.create({...input, emailId: 'new@example.com'}))
      .to.be.rejectedWith(/login is shared/);
  });

  it('restores an older shared login when its customer profile is active', async () => {
    let userUpdate: object | undefined;
    const controller = Object.assign(Object.create(RiderController.prototype), {
      rolesRepository: {findOne: async () => ({id: 'role-1'})},
      usersRepository: {
        findOne: async () => ({
          id: 'user-1', phone: input.phone, countryCode: '+91',
          email: 'customer@example.com', fullName: 'Customer Name', isActive: false,
        }),
        findById: async () => ({roles: [{value: 'rider'}, {value: 'customer'}]}),
        updateById: async (_id: string, data: object) => {userUpdate = data;},
      },
      customerRepository: {findOne: async () => ({isActive: true})},
      riderRepository: {
        findOne: async () => ({id: 'rider-1', riderCode: 'RID001', isDeleted: true}),
        updateById: async () => {},
      },
      riderPincodeMappingRepository: {updateAll: async () => {}},
      userRolesRepository: {findOne: async () => ({id: 'assignment-1'})},
      dataSource: {beginTransaction: async () => ({commit: async () => {}, rollback: async () => {}})},
    }) as RiderController;

    const result = await controller.create(input) as {rider: {user: {email: string; fullName: string}}};

    expect(userUpdate).to.eql({isActive: true});
    expect(result.rider.user).to.containEql({
      email: 'customer@example.com', fullName: 'Customer Name',
    });
  });

  for (const [label, roles, accountDisabled] of [
    ['shared', [{value: 'rider'}, {value: 'customer'}], false],
    ['rider-only', [{value: 'rider'}], true],
  ] as const) {
    it(`deletes a ${label} rider without changing unrelated login access`, async () => {
      let userUpdate: object | undefined;
      const controller = Object.assign(Object.create(RiderController.prototype), {
        riderRepository: {
          findOne: async () => ({id: 'rider-1', userId: 'user-1'}),
          updateById: async () => {},
        },
        usersRepository: {
          findById: async () => ({roles}),
          updateById: async (_id: string, data: object) => {userUpdate = data;},
        },
        dataSource: {beginTransaction: async () => ({commit: async () => {}, rollback: async () => {}})},
      }) as RiderController;

      await controller.deleteById('rider-1');
      expect(userUpdate).to.eql(accountDisabled ? {isActive: false} : undefined);
    });
  }
});
