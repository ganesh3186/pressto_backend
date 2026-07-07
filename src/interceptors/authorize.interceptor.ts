import {AuthenticationBindings} from '@loopback/authentication';
import {
  Getter,
  Interceptor,
  InvocationContext,
  InvocationResult,
  Provider,
  ValueOrPromise,
  globalInterceptor,
  inject,
} from '@loopback/core';
import {MetadataInspector} from '@loopback/metadata';
import {HttpErrors} from '@loopback/rest';
import {intersection} from 'lodash';
import {CurrentUser} from '../types';

@globalInterceptor('authorization', {tags: {name: 'authorize'}})
export class AuthorizeInterceptor implements Provider<Interceptor> {

  constructor(
    @inject.getter(AuthenticationBindings.CURRENT_USER)
    private getCurrentUser: Getter<CurrentUser>,
  ) { }

  value(): Interceptor {
    return this.intercept.bind(this);
  }

  async intercept(
    context: InvocationContext,
    next: () => ValueOrPromise<InvocationResult>,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authMeta: any = MetadataInspector.getMethodMetadata(
      'authorization.metadata',
      context.target!.constructor.prototype,
      context.methodName,
    );

    if (!authMeta) {
      return next();
    }

    const requiredRoles = authMeta.roles ?? [];
    const requiredPermissions = authMeta.permissions ?? [];

    if (!requiredRoles.length && !requiredPermissions.length) {
      return next();
    }

    const currentUser = await this.getCurrentUser();
    if (!currentUser) {
      throw new HttpErrors.Unauthorized('User not authenticated');
    }

    // SUPER ADMIN BYPASS
    if (currentUser.roles.includes('super_admin')) {
      return next();
    }

    if (requiredRoles.length > 0 && requiredPermissions.length > 0) {
      // Having the required role OR the required permission grants access
      const hasRole = intersection(currentUser.roles, requiredRoles).length > 0;
      const hasPerm = intersection(currentUser.permissions, requiredPermissions).length > 0;
      if (!hasRole && !hasPerm) {
        throw new HttpErrors.Forbidden('Forbidden: Insufficient role or permission');
      }
    } else if (requiredRoles.length > 0) {
      if (intersection(currentUser.roles, requiredRoles).length === 0) {
        throw new HttpErrors.Forbidden('Forbidden: Role not allowed');
      }
    } else if (requiredPermissions.length > 0) {
      if (intersection(currentUser.permissions, requiredPermissions).length === 0) {
        throw new HttpErrors.Forbidden('Forbidden: Permission not allowed');
      }
    }

    return next();
  }
}
