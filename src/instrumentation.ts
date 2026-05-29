import { AllStakNextClient, AllStakNextClientOptions, setClient, getClient } from './client';
import { instrumentFetch } from './fetch-instrumentation';
import { installDbInstrumentation, type DbInstrumentationOptions } from './db-instrumentation';
import { installConsoleLogBridge } from './logs';

export interface RegisterAllStakOptions extends AllStakNextClientOptions {
  /** Capture uncaughtException on the server. Defaults to true. */
  captureUncaughtExceptions?: boolean;
  /** Capture unhandledRejection on the server. Defaults to true. */
  captureUnhandledRejections?: boolean;
  /**
   * Auto-wire database query instrumentation that needs no live client
   * instance (the `pg` driver). Default true. Pass `false` to disable, or an
   * options object to toggle individual drivers. ORM integrations that need a
   * client instance (Prisma, Drizzle) are wired via the `instrumentPrisma()` /
   * `allstakDrizzleLogger()` exports. No-op outside the Node server runtime.
   */
  enableDbInstrumentation?: boolean | DbInstrumentationOptions;
  /**
   * Bridge `console.{debug,info,warn,error}` to `/ingest/v1/logs` so existing
   * `console.*` calls become structured logs (error+Error promoted to
   * captureException). Default true. The original console output is always
   * preserved. Set false to opt out.
   */
  enableConsoleLogs?: boolean;
}

/**
 * Register AllStak for Next.js App Router instrumentation.
 *
 * Call this inside your `instrumentation.ts` `register()` hook:
 *
 * ```ts
 * // instrumentation.ts
 * export async function register() {
 *   const { registerAllStak } = await import('@allstak/next');
 *   registerAllStak({ apiKey: process.env.ALLSTAK_API_KEY });
 * }
 * ```
 */
export function registerAllStak(options: RegisterAllStakOptions): AllStakNextClient {
  const existing = getClient();
  if (existing && !existing.isDestroyed()) {
    return existing;
  }

  const client = new AllStakNextClient(options);
  setClient(client);

  // Outbound HTTP instrumentation (node server + edge): wrap global fetch to
  // emit direction:'outbound' requests and propagate trace headers downstream.
  // Default on; fully fail-open. The browser wires this via initAllStakNext /
  // installGlobalErrorHandlers instead.
  if (options.enableOutboundHttp !== false) {
    try {
      instrumentFetch();
    } catch {
      // fail-open
    }
  }

  // Database query instrumentation (node server only): auto-wire the driver
  // wrappers that need no live client instance (currently `pg`). Default on,
  // individually toggleable, fully fail-open. No-op on edge/browser.
  if (options.enableDbInstrumentation !== false) {
    try {
      installDbInstrumentation(
        typeof options.enableDbInstrumentation === 'object' ? options.enableDbInstrumentation : {},
      );
    } catch {
      // fail-open
    }
  }

  // Console→logs bridge (default on): forward server-side `console.*` calls to
  // `/ingest/v1/logs` as structured logs, promoting error+Error to an event.
  // The original console output is always preserved. Fully fail-open.
  if (options.enableConsoleLogs !== false) {
    try {
      installConsoleLogBridge();
    } catch {
      // fail-open
    }
  }

  const captureUncaught = options.captureUncaughtExceptions !== false;
  const captureRejections = options.captureUnhandledRejections !== false;

  if (typeof process !== 'undefined' && process.on) {
    if (captureUncaught) {
      process.on('uncaughtException', (error: Error) => {
        try {
          client.captureException(error, { mechanism: 'uncaughtException' });
        } catch {
          // fail-open
        }
      });
    }

    if (captureRejections) {
      process.on('unhandledRejection', (reason: unknown) => {
        try {
          const error = reason instanceof Error ? reason : new Error(String(reason));
          client.captureException(error, { mechanism: 'unhandledRejection' });
        } catch {
          // fail-open
        }
      });
    }

    // Release-health: end the session on graceful shutdown. Best-effort and
    // fully fail-open — `endSession` is idempotent so multiple signals are safe.
    // Only wired when auto session tracking actually started a session (also
    // suppressed under the unit-test runtime, so tests don't register signals).
    if (client.isSessionTrackingEnabled()) {
      installSessionShutdownHooks(client);
    }
  }

  return client;
}

/**
 * Hook process-exit signals so the release-health session is ended (POST
 * `/ingest/v1/sessions/end`) on a graceful shutdown. `endSession` is idempotent
 * and best-effort: signal handlers re-raise the default behaviour after a
 * fire-and-forget end so they don't change the host process's exit semantics.
 */
function installSessionShutdownHooks(client: AllStakNextClient): void {
  const end = () => {
    try {
      client.endSession();
    } catch {
      // fail-open
    }
  };
  // `beforeExit`/`exit` cover normal teardown; the signals cover container/
  // orchestrator stops. We do NOT call process.exit ourselves.
  process.on('beforeExit', end);
  process.on('exit', end);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    try {
      process.on(signal, () => {
        end();
      });
    } catch {
      // some runtimes disallow custom signal handlers — ignore
    }
  }
}
