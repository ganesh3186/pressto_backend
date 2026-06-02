import {UserService} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {Credentials} from '../interfaces/credentials.interface';
import {Users} from '../models';
import {UsersRepository} from '../repositories';
import {BcryptHasher} from './hash.password.bcrypt';

export class MyUserService implements UserService<Users, Credentials> {
  constructor(
    @repository(UsersRepository)
    public userRepository: UsersRepository,

    @inject('service.hasher')
    public hasher: BcryptHasher,
  ) { }

  async verifyCredentials(credentials: Credentials): Promise<Users> {
    const user = await this.userRepository.findOne({
      where: {email: credentials.email},
    });

    if (!user) {
      throw new HttpErrors.BadRequest('User not found');
    }

    if (!user.password) {
      throw new HttpErrors.BadRequest('Password not set for this account');
    }

    // if (!user.isActive) {
    //   throw new HttpErrors.Forbidden('User is not active');
    // }

    const isPasswordValid = await this.hasher.comparePassword(
      credentials.password,
      user.password,
    );

    if (!isPasswordValid) {
      throw new HttpErrors.Unauthorized('Invalid password');
    }

    return user;
  }

  convertToUserProfile(user: Users): UserProfile {
    return {
      [securityId]: user.id!,
      id: user.id!,
      email: user.email,
      name: user.fullName,
      phone: user.phone,
      roles: user.roles
    };
  }
}
