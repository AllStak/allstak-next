'use client';

import { AllStakErrorBoundary } from '@allstak/next';

/**
 * Next.js App Router error boundary for route segments.
 *
 * This wraps the built-in error.tsx convention with AllStakErrorBoundary
 * so that rendering errors in any route segment are automatically captured.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <AllStakErrorBoundary
      fallback={
        <div style={{ padding: '2rem' }}>
          <h2>Something went wrong</h2>
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
              backgroundColor: '#0070f3',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Try Again
          </button>
        </div>
      }
    >
      {/* This boundary catches errors that bubble up from child components */}
      <div />
    </AllStakErrorBoundary>
  );
}
