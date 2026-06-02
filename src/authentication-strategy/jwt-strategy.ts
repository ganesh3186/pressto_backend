import {AuthenticationStrategy} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {HttpErrors, Request} from '@loopback/rest';
import {UserProfile} from '@loopback/security';
import { JWTService } from '../services/jwt-service';

export class JWTStrategy implements AuthenticationStrategy {
  name = 'jwt';

  constructor(
    @inject('service.jwt.service')
    public jwtService: JWTService,
  ) {}

  async authenticate(request: Request): Promise<UserProfile | undefined> {
    const token = this.extractCredentials(request);
    const userProfile = await this.jwtService.verifyToken(token);
    return userProfile;
  }

  extractCredentials(request: Request): string {
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      throw new HttpErrors.Unauthorized('Authorization header is missing');
    }

    if (!authHeader.startsWith('Bearer ')) {
      throw new HttpErrors.BadRequest(
        'Authorization header must be of type Bearer',
      );
    }

    const parts = authHeader.split(' ');

    if (parts.length !== 2) {
      throw new HttpErrors.BadRequest(
        `Authorization header must be in the format: 'Bearer <token>'`,
      );
    }

    return parts[1]; // the token
  }
}
