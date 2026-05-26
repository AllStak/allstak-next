import { getClient, type SpanPayload } from './client';
import { scopeManager } from './scope';

type RouteRequest = {
  headers?: Headers;
  url?: string;
  method?: string;
};

type RouteResponse = {
  headers?: Headers;
  status?: number;
};

type RouteHandler<TRequest extends RouteRequest = RouteRequest, TContext = unknown, TResponse extends RouteResponse = RouteResponse> = (
  request: TRequest,
  context?: TContext,
) => TResponse | Promise<TResponse>;

type ServerAction<TArgs extends unknown[] = unknown[], TResult = unknown> = (...args: TArgs) => TResult | Promise<TResult>;

export interface ServerActionTelemetryOptions {
  name?: string;
  operation?: string;
  tags?: Record<string, string>;
}

export interface RouteTelemetryContext {
  traceId: string;
  requestId: string;
  spanId: string;
  parentSpanId: string;
  method: string;
  host: string;
  path: string;
  startTimeMillis: number;
}

export function withAllStakRouteHandler<
  TRequest extends RouteRequest,
  TContext,
  TResponse extends RouteResponse,
>(handler: RouteHandler<TRequest, TContext, TResponse>): RouteHandler<TRequest, TContext, TResponse> {
  // Run the entire handler inside a fresh request-isolated scope so user/tags
  // set via setUser/setTag inside the handler attach to errors captured for
  // THIS request and don't leak across concurrent requests.
  return async (request: TRequest, context?: TContext): Promise<TResponse> => scopeManager.runInRequestScope(async () => {
    const telemetry = createRouteTelemetryContext(request);

    try {
      const response = await handler(request, context);
      const endTimeMillis = Date.now();
      const statusCode = response.status ?? 200;
      setTraceHeaders(response.headers, telemetry, endTimeMillis);
      await captureRouteTelemetry(telemetry, statusCode, endTimeMillis);
      return response;
    } catch (error) {
      const endTimeMillis = Date.now();
      const client = getClient();
      if (client) {
        await failOpen(() => client.captureException(toError(error), {
          mechanism: 'route-handler',
          url: request.url,
          method: telemetry.method,
          traceId: telemetry.traceId,
          requestId: telemetry.requestId,
        }));
      }
      await captureRouteTelemetry(telemetry, 500, endTimeMillis, 'error');
      throw error;
    }
  });
}

export function withAllStakServerAction<TArgs extends unknown[], TResult>(
  action: ServerAction<TArgs, TResult>,
  options: ServerActionTelemetryOptions = {},
): ServerAction<TArgs, TResult> {
  return async (...args: TArgs): Promise<TResult> => scopeManager.runInRequestScope(async () => {
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    const startTimeMillis = Date.now();
    const operation = options.operation ?? 'next.server_action';
    const description = options.name ?? action.name ?? 'server_action';

    try {
      const result = await action(...args);
      await captureServerActionTelemetry({
        traceId,
        spanId,
        startTimeMillis,
        endTimeMillis: Date.now(),
        operation,
        description,
        status: 'ok',
        tags: options.tags,
      });
      return result;
    } catch (error) {
      const endTimeMillis = Date.now();
      const client = getClient();
      if (client) {
        await failOpen(() => client.captureException(toError(error), {
          mechanism: 'server-action',
          action: description,
          traceId,
          spanId,
        }));
      }
      await captureServerActionTelemetry({
        traceId,
        spanId,
        startTimeMillis,
        endTimeMillis,
        operation,
        description,
        status: 'error',
        tags: options.tags,
      });
      throw error;
    }
  });
}

export function createRouteTelemetryContext(request: RouteRequest): RouteTelemetryContext {
  const parsed = parseRequestUrl(request.url);
  const incoming = readIncomingTrace(request.headers);
  return {
    traceId: readHeader(request.headers, 'x-allstak-trace-id') ?? incoming.traceId ?? generateTraceId(),
    requestId: readHeader(request.headers, 'x-allstak-request-id') ?? readHeader(request.headers, 'x-request-id') ?? generateTraceId(),
    spanId: generateSpanId(),
    parentSpanId: readHeader(request.headers, 'x-allstak-parent-span-id') ?? incoming.parentSpanId ?? '',
    method: (request.method || 'GET').toUpperCase(),
    host: parsed.host,
    path: parsed.path,
    startTimeMillis: Date.now(),
  };
}

async function captureServerActionTelemetry(args: {
  traceId: string;
  spanId: string;
  startTimeMillis: number;
  endTimeMillis: number;
  operation: string;
  description: string;
  status: SpanPayload['status'];
  tags?: Record<string, string>;
}): Promise<void> {
  const client = getClient();
  if (!client) return;
  const durationMs = Math.max(0, args.endTimeMillis - args.startTimeMillis);
  await failOpen(() => client.captureSpan({
    traceId: args.traceId,
    spanId: args.spanId,
    parentSpanId: '',
    operation: args.operation,
    description: args.description,
    status: args.status,
    durationMs,
    startTimeMillis: args.startTimeMillis,
    endTimeMillis: args.endTimeMillis,
    service: 'nextjs',
    environment: client.getEnvironment(),
    tags: {
      component: 'server-action',
      ...(args.tags ?? {}),
    },
    data: JSON.stringify({ action: args.description }),
  }));
}

async function captureRouteTelemetry(
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
      operation: 'next.route',
      description: `${telemetry.method} ${telemetry.path}`,
      status: forcedStatus ?? (statusCode >= 500 ? 'error' : 'ok'),
      durationMs,
      startTimeMillis: telemetry.startTimeMillis,
      endTimeMillis,
      service: 'nextjs',
      environment: client.getEnvironment(),
      tags: {
        component: 'route-handler',
        method: telemetry.method,
        statusCode: String(statusCode),
      },
      data: JSON.stringify({ host: telemetry.host, path: telemetry.path }),
    })),
  ]);
}

export function setTraceHeaders(headers: Headers | undefined, telemetry: RouteTelemetryContext, endTimeMillis: number): void {
  if (!headers) return;
  try {
    headers.set('x-allstak-trace-id', telemetry.traceId);
    headers.set('x-allstak-request-id', telemetry.requestId);
    headers.set('x-allstak-span-id', telemetry.spanId);
    headers.set('traceparent', `00-${telemetry.traceId}-${telemetry.spanId}-01`);
    headers.set('baggage', mergeBaggage(headers.get('baggage'), telemetry));
    headers.set('allstak-baggage', allstakBaggage(telemetry));
    headers.set('server-timing', `allstak;dur=${Math.max(0, endTimeMillis - telemetry.startTimeMillis)}`);
  } catch {
    // Some Next.js response headers are immutable depending on runtime path.
  }
}

function mergeBaggage(existing: string | null | undefined, telemetry: RouteTelemetryContext): string {
  const own = allstakBaggage(telemetry);
  if (!existing || !existing.trim()) return own;
  const retained = existing
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry && !entry.toLowerCase().startsWith('allstak-'));
  retained.push(own);
  return retained.join(',');
}

function allstakBaggage(telemetry: RouteTelemetryContext): string {
  return [
    `allstak-trace_id=${telemetry.traceId}`,
    `allstak-request_id=${telemetry.requestId}`,
    `allstak-span_id=${telemetry.spanId}`,
  ].join(',');
}

function parseRequestUrl(url: string | undefined): { host: string; path: string } {
  if (!url) return { host: '', path: '/' };
  try {
    const parsed = new URL(url);
    return { host: parsed.host, path: `${parsed.pathname}${parsed.search}` };
  } catch {
    return { host: '', path: url.startsWith('/') ? url : `/${url}` };
  }
}

function readIncomingTrace(headers: Headers | undefined): { traceId?: string; parentSpanId?: string } {
  const traceparent = headers?.get('traceparent');
  const match = traceparent?.match(/^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/i);
  if (!match) return {};
  return { traceId: match[1].toLowerCase(), parentSpanId: match[2].toLowerCase() };
}

function readHeader(headers: Headers | undefined, name: string): string | undefined {
  const value = headers?.get(name);
  return value && value.trim() ? value.trim() : undefined;
}

function generateTraceId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function generateSpanId(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function failOpen(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch {
    // Telemetry must never affect the user's route response.
  }
}
