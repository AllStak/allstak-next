import { resolveDebugId } from './utils/debug-id';
import { scrub } from './sanitize';

const DEFAULT_HOST = 'https://api.allstak.sa';
export const SDK_NAME = '@allstak/next';
export const SDK_VERSION = '0.1.3';
const TRANSPORT_TIMEOUT_MS = 3000;
const MAX_BREADCRUMBS = 30;

export type BreadcrumbType = 'navigation' | 'ui' | 'http' | 'console' | 'custom';
/** @deprecated Use BreadcrumbType instead */
export type BreadcrumbCategory = BreadcrumbType;
export type SeverityLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

export interface Breadcrumb {
  timestamp: string;
  type: BreadcrumbType;
  message: string;
  level?: string;
  data?: Record<string, unknown>;
}

export interface StackFrame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
  debugId?: string;
}

export interface DebugImage {
  type: 'sourcemap';
  debugId: string;
}

export interface ErrorPayload {
  exceptionClass: string;
  message: string;
  stackTrace: string[];
  frames: StackFrame[];
  level: SeverityLevel;
  environment: string;
  release: string;
  breadcrumbs: Breadcrumb[];
  metadata: Record<string, unknown>;
  timestamp: string;
  sdkName: string;
  sdkVersion: string;
  platform: string;
  debugMeta?: { images: DebugImage[] };
}

export interface SpanPayload {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  operation: string;
  description: string;
  status: 'ok' | 'error' | 'timeout';
  durationMs: number;
  startTimeMillis: number;
  endTimeMillis: number;
  service: string;
  environment: string;
  tags: Record<string, string>;
  data: string;
}

export interface HttpRequestPayload {
  traceId: string;
  requestId: string;
  spanId?: string;
  parentSpanId?: string;
  direction: 'inbound' | 'outbound';
  method: string;
  host: string;
  path: string;
  statusCode: number;
  durationMs: number;
  environment?: string;
  release?: string;
  timestamp: string;
}

export interface AllStakNextClientOptions {
  apiKey?: string;
  dsn?: string;
  host?: string;
  endpoint?: string;
  environment?: string;
  release?: string;
}

export class AllStakNextClient {
  private readonly apiKey: string;
  private readonly host: string;
  private readonly environment: string;
  private readonly release: string;
  private breadcrumbs: Breadcrumb[] = [];
  private destroyed = false;
  private pendingRequests: Promise<void>[] = [];

  constructor(options: AllStakNextClientOptions) {
    this.apiKey = options.apiKey || options.dsn || '';
    this.host = (options.host || options.endpoint || DEFAULT_HOST).replace(/\/$/, '');
    this.environment = options.environment || '';
    this.release = options.release || '';
  }

  addBreadcrumb(breadcrumb: Omit<Breadcrumb, 'timestamp'>): void {
    if (this.destroyed) return;
    this.breadcrumbs.push({ ...breadcrumb, timestamp: new Date().toISOString() });
    if (this.breadcrumbs.length > MAX_BREADCRUMBS) {
      this.breadcrumbs = this.breadcrumbs.slice(-MAX_BREADCRUMBS);
    }
  }

  async captureException(error: Error, context: Record<string, unknown> = {}): Promise<void> {
    if (this.destroyed || !this.apiKey) return;
    const frames = parseStack(error.stack);

    // Resolve debug-IDs per frame so the symbolicator can pick the
    // right source map for each stack frame.
    for (const frame of frames) {
      const id = resolveDebugId(frame.filename);
      if (id) frame.debugId = id;
    }

    // Aggregate unique debug-IDs into debugMeta.images[] so the
    // backend can match by image-level debugId as well.
    const debugIdSet = new Set<string>();
    for (const f of frames) if (f.debugId) debugIdSet.add(f.debugId);
    const debugMeta = debugIdSet.size > 0
      ? { images: Array.from(debugIdSet).map((id): DebugImage => ({ type: 'sourcemap' as const, debugId: id })) }
      : undefined;

    const payload: ErrorPayload = {
      exceptionClass: error.name || 'Error',
      message: error.message,
      stackTrace: formatFrames(frames),
      frames,
      level: 'error',
      environment: this.environment,
      release: this.release,
      breadcrumbs: [...this.breadcrumbs],
      metadata: { sdkName: SDK_NAME, sdkVersion: SDK_VERSION, ...context },
      timestamp: new Date().toISOString(),
      sdkName: SDK_NAME,
      sdkVersion: SDK_VERSION,
      platform: 'node',
      debugMeta,
    };
    await this.send('/ingest/v1/errors', payload);
  }

  async captureMessage(message: string, level: SeverityLevel = 'info'): Promise<void> {
    if (this.destroyed || !this.apiKey) return;
    const payload: ErrorPayload = {
      exceptionClass: 'Message',
      message,
      stackTrace: [],
      frames: [],
      level,
      environment: this.environment,
      release: this.release,
      breadcrumbs: [...this.breadcrumbs],
      metadata: { sdkName: SDK_NAME, sdkVersion: SDK_VERSION },
      timestamp: new Date().toISOString(),
      sdkName: SDK_NAME,
      sdkVersion: SDK_VERSION,
      platform: 'node',
    };
    await this.send('/ingest/v1/errors', payload);
  }

  async captureSpan(span: SpanPayload): Promise<void> {
    if (this.destroyed || !this.apiKey) return;
    await this.send('/ingest/v1/spans', { spans: [span] });
  }

  async captureRequest(request: HttpRequestPayload): Promise<void> {
    if (this.destroyed || !this.apiKey) return;
    await this.send('/ingest/v1/http-requests', {
      requests: [{
        ...request,
        environment: request.environment ?? this.environment,
        release: request.release ?? this.release,
      }],
    });
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.pendingRequests);
    this.pendingRequests = [];
  }

  destroy(): void {
    this.destroyed = true;
    this.breadcrumbs = [];
    this.pendingRequests = [];
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  getBreadcrumbs(): ReadonlyArray<Breadcrumb> {
    return this.breadcrumbs;
  }

  getEnvironment(): string {
    return this.environment;
  }

  getRelease(): string {
    return this.release;
  }

  private async send(path: string, payload: unknown): Promise<void> {
    const request = this.doFetch(path, payload);
    this.pendingRequests.push(request);
    await request;
  }

  private async doFetch(path: string, payload: unknown): Promise<void> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TRANSPORT_TIMEOUT_MS);
      try {
        // Scrub the full wire payload before serialization. One chokepoint
        // protects every telemetry type. Pure (no caller mutation),
        // fail-open on sanitizer error.
        let body: string;
        try {
          body = JSON.stringify(scrub(payload));
        } catch {
          body = JSON.stringify(payload);
        }
        await fetch(`${this.host}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-AllStak-Key': this.apiKey,
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      // fail-open: never throw into the host app
    }
  }
}

export function parseStack(stack?: string): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  const lines = stack.split('\n');
  for (const line of lines) {
    const match = line.match(/^\s+at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
    if (match) {
      frames.push({
        function: match[1] || '<anonymous>',
        filename: match[2],
        lineno: parseInt(match[3], 10),
        colno: parseInt(match[4], 10),
        in_app: !match[2]?.includes('node_modules'),
      });
    }
  }
  return frames;
}

export function formatFrames(frames: StackFrame[]): string[] {
  return frames.map((f) => {
    const fn = f.function || '<anonymous>';
    const file = f.filename || '<unknown>';
    return `at ${fn} (${file}:${f.lineno ?? 0}:${f.colno ?? 0})`;
  });
}

let clientSingleton: AllStakNextClient | null = null;

export function getClient(): AllStakNextClient | null {
  return clientSingleton;
}

export function setClient(client: AllStakNextClient | null): void {
  clientSingleton = client;
}
