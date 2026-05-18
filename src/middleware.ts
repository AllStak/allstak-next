import { getClient } from './client';

type NextRequest = { headers: Headers; url: string; method: string };
type NextResponse = { headers: Headers };
type MiddlewareHandler = (request: NextRequest) => NextResponse | Promise<NextResponse>;

/**
 * Wrap a Next.js middleware handler to capture errors and inject trace headers.
 *
 * ```ts
 * // middleware.ts
 * import { withAllStakMiddleware } from '@allstak/next';
 * import { NextResponse } from 'next/server';
 *
 * export default withAllStakMiddleware(async (request) => {
 *   return NextResponse.next();
 * });
 * ```
 */
export function withAllStakMiddleware(handler: MiddlewareHandler): MiddlewareHandler {
  return async (request: NextRequest) => {
    const traceId = generateTraceId();
    const startTime = Date.now();

    try {
      const response = await handler(request);

      // Add trace headers to the response
      try {
        response.headers.set('x-allstak-trace-id', traceId);
        response.headers.set('server-timing', `allstak;dur=${Date.now() - startTime}`);
      } catch {
        // Headers may be immutable in some contexts
      }

      return response;
    } catch (error) {
      try {
        const client = getClient();
        if (client) {
          const err = error instanceof Error ? error : new Error(String(error));
          await client.captureException(err, {
            mechanism: 'middleware',
            url: request.url,
            method: request.method,
            traceId,
          });
        }
      } catch {
        // fail-open
      }
      throw error; // re-throw so Next.js handles it
    }
  };
}

function generateTraceId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join('');
}
