import { getClient } from './client';

export interface NextErrorContext {
  res?: { statusCode?: number };
  err?: Error | null;
  asPath?: string;
  pathname?: string;
  query?: Record<string, unknown>;
}

/**
 * Capture an error from Next.js Pages Router `_error.tsx` `getInitialProps`.
 *
 * ```tsx
 * // pages/_error.tsx
 * import { captureUnderscoreErrorException } from '@allstak/next';
 * import NextErrorComponent from 'next/error';
 *
 * function CustomError({ statusCode }) {
 *   return <NextErrorComponent statusCode={statusCode} />;
 * }
 *
 * CustomError.getInitialProps = async (ctx) => {
 *   await captureUnderscoreErrorException(ctx);
 *   return NextErrorComponent.getInitialProps(ctx);
 * };
 *
 * export default CustomError;
 * ```
 */
export async function captureUnderscoreErrorException(ctx: NextErrorContext): Promise<void> {
  const error = ctx.err;
  if (!error) return;

  try {
    const client = getClient();
    if (!client) return;

    await client.captureException(error, {
      mechanism: 'pages-error',
      statusCode: ctx.res?.statusCode,
      asPath: ctx.asPath,
      pathname: ctx.pathname,
    });
  } catch {
    // fail-open
  }
}
