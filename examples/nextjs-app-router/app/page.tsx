import Link from 'next/link';

export default function HomePage() {
  return (
    <main>
      <h1>AllStak Next.js App Router Example</h1>
      <p>
        This example demonstrates the <code>@allstak/next</code> SDK integration
        with Next.js 14 App Router.
      </p>

      <h2>Integration Points</h2>
      <ul>
        <li>
          <strong>instrumentation.ts</strong> &mdash; Server-side SDK
          initialization via <code>registerAllStak()</code>
        </li>
        <li>
          <strong>middleware.ts</strong> &mdash; Request tracing via{' '}
          <code>withAllStakMiddleware()</code>
        </li>
        <li>
          <strong>next.config.mjs</strong> &mdash; Source map upload via{' '}
          <code>withAllStak()</code>
        </li>
        <li>
          <strong>error.tsx</strong> &mdash; Route error boundary via{' '}
          <code>AllStakErrorBoundary</code>
        </li>
        <li>
          <strong>global-error.tsx</strong> &mdash; Root error boundary
        </li>
      </ul>

      <h2>Try It</h2>
      <p>
        <Link
          href="/demo"
          style={{
            display: 'inline-block',
            padding: '0.75rem 1.5rem',
            backgroundColor: '#0070f3',
            color: 'white',
            borderRadius: '6px',
            textDecoration: 'none',
            fontWeight: 600,
          }}
        >
          Open Demo Page
        </Link>
      </p>
    </main>
  );
}
