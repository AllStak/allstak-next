import { getClient, type SpanPayload } from './client';
import { createRouteTelemetryContext, setTraceHeaders, type RouteTelemetryContext } from './route-handler';

type NextRequest = { headers: Headers; url: string; method: string };
type NextResponse = { headers: Headers; status?: number };
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
    const telemetry = createRouteTelemetryContext(request);

    try {
      const response = await handler(request);
      const endTimeMillis = Date.now();

      setTraceHeaders(response.headers, telemetry, endTimeMillis);

      await captureMiddlewareTelemetry(telemetry, response.status ?? 200, endTimeMillis);
      return response;
    } catch (error) {
      const endTimeMillis = Date.now();
      try {
        const client = getClient();
        if (client) {
          const err = error instanceof Error ? error : new Error(String(error));
          await client.captureException(err, {
            mechanism: 'middleware',
            url: request.url,
            method: request.method,
            traceId: telemetry.traceId,
            requestId: telemetry.requestId,
          });
        }
      } catch {
        // fail-open
      }
      await captureMiddlewareTelemetry(telemetry, 500, endTimeMillis, 'error');
      throw error; // re-throw so Next.js handles it
    }
  };
}

async function captureMiddlewareTelemetry(
  telemetry: RouteTelemetryContext,
  statusCode: number,
  endTimeMillis: number,
  forcedStatus?: SpanPayload['status'],
): Promise<void> {
  const client = getClient();
  if (!client) return;

  const durationMs = Math.max(0, endTimeMillis - telemetry.startTimeMillis);
  await Promise.allSettled([
    failOpen(() => client.captureRequest({
      traceId: telemetry.traceId,
      requestId: telemetry.requestId,
      spanId: telemetry.spanId,
      parentSpanId: telemetry.parentSpanId,
      direction: 'inbound',
      method: telemetry.method,
      host: telemetry.host,
      path: telemetry.path,
      statusCode,
      durationMs,
      timestamp: new Date(endTimeMillis).toISOString(),
    })),
    failOpen(() => client.captureSpan({
      traceId: telemetry.traceId,
      spanId: telemetry.spanId,
      parentSpanId: telemetry.parentSpanId,
      operation: 'next.middleware',
      description: `${telemetry.method} ${telemetry.path}`,
      status: forcedStatus ?? (statusCode >= 500 ? 'error' : 'ok'),
      durationMs,
      startTimeMillis: telemetry.startTimeMillis,
      endTimeMillis,
      service: 'nextjs',
      environment: client.getEnvironment(),
      tags: {
        component: 'middleware',
        method: telemetry.method,
        statusCode: String(statusCode),
      },
      data: JSON.stringify({ host: telemetry.host, path: telemetry.path }),
    })),
  ]);
}

async function failOpen(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch {
    // Telemetry must never affect middleware control flow.
  }
}
