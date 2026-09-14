import {
  globalInterceptor,
  Interceptor,
  InvocationContext,
  InvocationResult,
  Provider,
  ValueOrPromise,
} from '@loopback/core';
import {HttpErrors} from '@loopback/rest';

@globalInterceptor('unique-constraint', {tags: {name: 'uniqueConstraint'}})
export class UniqueConstraintInterceptor implements Provider<Interceptor> {

  value(): Interceptor {
    return this.intercept.bind(this);
  }

  async intercept(
    context: InvocationContext,
    next: () => ValueOrPromise<InvocationResult>
  ): Promise<InvocationResult> {

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    try {
      // Controller methods may return either a value or a Promise.
      return await next();
    } catch (error: any) {

      if (error?.code === '23505') {

        let message = 'Duplicate value violates unique constraint';

        if (error?.detail) {
          message = error.detail
            .replace('Key', '')
            .replace(/[()=]/g, ' ')
            .trim();
        }

        throw new HttpErrors.BadRequest(message);
      }

      // Postgres Foreign Key Violation
      if (error?.code === '23503') {
        throw new HttpErrors.BadRequest(
          'Invalid reference — related record does not exist'
        );
      }

      throw error;
    }
  }
}
