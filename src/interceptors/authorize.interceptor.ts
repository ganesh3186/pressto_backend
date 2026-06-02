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

    // ROLE CHECK
    if (requiredRoles.length > 0) {
      const matched = intersection(currentUser.roles, requiredRoles);
      if (matched.length === 0) {
        console.log('required roles', requiredRoles)
        console.log('currentuser roles', currentUser);
        throw new HttpErrors.Forbidden('Forbidden: Role not allowed');
      }
    }

    // PERMISSION CHECK
    if (requiredPermissions.length > 0) {
      const matched = intersection(currentUser.permissions, requiredPermissions);
      if (matched.length === 0) {
        throw new HttpErrors.Forbidden('Forbidden: Permission not allowed');
      }
    }

    return next();
  }
}
