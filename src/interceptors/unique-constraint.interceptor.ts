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
    next: () => ValueOrPromise<InvocationResult>,
  ): Promise<InvocationResult> {
    // next() is typed ValueOrPromise (effectively `any`, since
    // InvocationResult itself is `any`) — a synchronous controller method
    // (e.g. PingController.ping()) resolves it to a plain value with no
    // .catch(), so chaining .catch() directly on next() throws
    // "next(...).catch is not a function" for any such handler.
    // Promise.resolve(...) normalizes either case into a real Promise.
    try {
      return await Promise.resolve(next());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
          'Invalid reference — related record does not exist',
        );
      }

      throw error;
    }
  }
}
