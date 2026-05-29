'use client';

import { useState, useEffect } from 'react';
import { captureException, installGlobalErrorHandlers, AllStakErrorBoundary } from '@allstak/next';

// Install global handlers once on module load (client-side only)
if (typeof window !== 'undefined') {
  installGlobalErrorHandlers();
}

/** A component that throws during render to test the error boundary. */
function BrokenComponent(): React.ReactNode {
  throw new Error('Render error: component threw during render');
}

export default function DemoPage() {
  const [showBroken, setShowBroken] = useState(false);
  const [serverResult, setServerResult] = useState<string | null>(null);
  const [manualResult, setManualResult] = useState<string | null>(null);

  const handleClientError = () => {
    try {
      throw new Error('Client error: thrown in event handler');
    } catch (err) {
      captureException(err as Error, { mechanism: 'manual-event-handler' });
      alert('Client error thrown and captured. Check your AllStak dashboard.');
    }
  };

  const handleServerError = async () => {
    setServerResult('Loading...');
    try {
      const res = await fetch('/api/test-error');
      const data = await res.json();
      setServerResult(`Server responded: ${data.error} (captured: ${data.captured})`);
    } catch (err) {
      setServerResult(`Fetch failed: ${(err as Error).message}`);
    }
  };

  const handleManualCapture = async () => {
    const error = new Error('Manually captured error via captureException');
    error.name = 'ManualCaptureDemo';
    await captureException(error, {
      mechanism: 'manual',
      demo: true,
      timestamp: new Date().toISOString(),
    });
    setManualResult('Error captured manually. Check your AllStak dashboard.');
  };

  return (
    <main>
      <h1>AllStak SDK Demo</h1>
      <p>
        Use the buttons below to test different error capture scenarios.
        Each button demonstrates a different integration point.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: '500px' }}>
        {/* Client Error */}
        <section>
          <button onClick={handleClientError} style={buttonStyle}>
            Trigger Client Error
          </button>
          <p style={descStyle}>
            Throws an error in an event handler and captures it with{' '}
            <code>captureException()</code>.
          </p>
        </section>

        {/* Server Error */}
        <section>
          <button onClick={handleServerError} style={buttonStyle}>
            Trigger Server Error
          </button>
          <p style={descStyle}>
            Calls <code>/api/test-error</code> which throws and captures on the server.
          </p>
          {serverResult && (
            <pre style={resultStyle}>{serverResult}</pre>
          )}
        </section>

        {/* Render Error */}
        <section>
          <button onClick={() => setShowBroken(true)} style={buttonStyle}>
            Trigger Render Error
          </button>
          <p style={descStyle}>
            Renders a component that throws during render, caught by{' '}
            <code>AllStakErrorBoundary</code>.
          </p>
          {showBroken && (
            <AllStakErrorBoundary
              fallback={(error: Error) => (
                <div style={{ ...resultStyle, borderColor: '#dc2626' }}>
                  <strong>Caught by AllStakErrorBoundary:</strong>
                  <br />
                  {error.message}
                  <br />
                  <button
                    onClick={() => setShowBroken(false)}
                    style={{ marginTop: '0.5rem', cursor: 'pointer' }}
                  >
                    Reset
                  </button>
                </div>
              )}
            >
              <BrokenComponent />
            </AllStakErrorBoundary>
          )}
        </section>

        {/* Manual Capture */}
        <section>
          <button onClick={handleManualCapture} style={buttonStyle}>
            Manual Capture
          </button>
          <p style={descStyle}>
            Calls <code>captureException()</code> directly without throwing.
          </p>
          {manualResult && (
            <pre style={resultStyle}>{manualResult}</pre>
          )}
        </section>
      </div>

      <p style={{ marginTop: '2rem' }}>
        <a href="/" style={{ color: '#0070f3' }}>
          Back to Home
        </a>
      </p>
    </main>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: '0.6rem 1.2rem',
  backgroundColor: '#111',
  color: '#fff',
  border: 'none',
  borderRadius: '6px',
  cursor: 'pointer',
  fontSize: '0.95rem',
  fontWeight: 500,
};

const descStyle: React.CSSProperties = {
  marginTop: '0.4rem',
  color: '#555',
  fontSize: '0.9rem',
};

const resultStyle: React.CSSProperties = {
  marginTop: '0.5rem',
  padding: '0.75rem',
  backgroundColor: '#f5f5f5',
  border: '1px solid #ddd',
  borderRadius: '4px',
  fontSize: '0.85rem',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
