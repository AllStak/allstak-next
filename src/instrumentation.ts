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
  }

  return client;
}
