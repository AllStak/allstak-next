'use client';

import { captureException } from '@allstak/next';
import { useEffect } from 'react';

/**
 * Root-level error boundary for the entire application.
 *
 * This catches errors that escape route-level error.tsx boundaries,
 * including errors in the root layout itself.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, { mechanism: 'global-error-boundary' });
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: '2rem' }}>
        <h1>Application Error</h1>
        <p style={{ color: '#666' }}>{error.message}</p>
        {error.digest && (
          <p style={{ fontSize: '0.85rem', color: '#999' }}>
            Digest: {error.digest}
          </p>
        )}
        <button
          onClick={reset}
          style={{
            marginTop: '1rem',
            padding: '0.5rem 1rem',
            backgroundColor: '#dc2626',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          Try Again
        </button>
      </body>
    </html>
  );
}
