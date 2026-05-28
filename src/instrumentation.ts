import { AllStakNextClient, AllStakNextClientOptions, setClient, getClient } from './client';

export interface RegisterAllStakOptions extends AllStakNextClientOptions {
  /** Capture uncaughtException on the server. Defaults to true. */
  captureUncaughtExceptions?: boolean;
  /** Capture unhandledRejection on the server. Defaults to true. */
  captureUnhandledRejections?: boolean;
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
