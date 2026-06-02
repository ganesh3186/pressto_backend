/* eslint-disable @typescript-eslint/no-explicit-any */
import {injectable, BindingScope, inject} from '@loopback/core';
import {TokenService} from '@loopback/authentication';
import {HttpErrors} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import * as jwt from 'jsonwebtoken';

@injectable({scope: BindingScope.SINGLETON})
export class JWTService implements TokenService {
  constructor(
    @inject('jwt.secret') private jwtSecret: string,
    @inject('jwt.expiresIn') private jwtExpiresIn: string,
  ) {}


  private async signJwt(
    payload: any,
    expiresIn: jwt.SignOptions['expiresIn'],
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      jwt.sign(
        payload,
        this.jwtSecret,
        {expiresIn},
        (err: any, token: string | undefined) => {
          if (err || !token) return reject(err ?? new Error('Token generation failed'));
          resolve(token);
        },
      );
    });
  }


  private async verifyJwt(token: string): Promise<any> {
    return new Promise((resolve, reject) => {
      jwt.verify(token, this.jwtSecret, (err: any, decoded: any) => {
        if (err) return reject(err);
        resolve(decoded);
      });
    });
  }


  async generateToken(userProfile: UserProfile): Promise<string> {
    if (!userProfile) {
      throw new HttpErrors.NotFound('User profile is null');
    }

    return this.signJwt(
      userProfile,
      this.jwtExpiresIn as jwt.SignOptions['expiresIn']
    );
  }

  async generateShortToken(userProfile: UserProfile): Promise<string> {
    if (!userProfile) {
      throw new HttpErrors.NotFound('User profile is null');
    }

    return this.signJwt('10m', '10m' as jwt.SignOptions['expiresIn']);
  }


  async verifyToken(token: string): Promise<UserProfile> {
    if (!token) {
      throw new HttpErrors.Unauthorized('Token is null');
    }

    try {
      const decrypted: any = await this.verifyJwt(token);

      const userProfile: UserProfile = {
        [securityId]: decrypted.id,
        id: decrypted.id,
        email: decrypted.email,
        phoneNumber: decrypted.phoneNumber,
        roles: decrypted.roles ?? [],
        permissions: decrypted.permissions ?? [],
      };

      return userProfile;
    } catch (error: any) {
      throw new HttpErrors.Unauthorized(
        `Error verifying token: ${error.message}`,
      );
    }
  }
}
