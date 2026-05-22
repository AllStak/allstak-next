import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { AllStakErrorBoundary, withAllStakErrorBoundary } from '../src/error-boundary';
import { AllStakNextClient, setClient } from '../src/client';

// Minimal render helper – we don't need react-dom/test-utils; we test
// the class behaviour directly via React.createElement + manual lifecycle.

describe('AllStakErrorBoundary', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    setClient(null);
    vi.restoreAllMocks();
  });

  it('getDerivedStateFromError captures the error in state', () => {
    const result = AllStakErrorBoundary.getDerivedStateFromError(new Error('boom'));
    expect(result).toEqual({ error: expect.any(Error) });
    expect(result.error!.message).toBe('boom');
  });

  it('componentDidCatch sends error to AllStak client', () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test', host: 'https://api.allstak.sa' });
    const captureSpy = vi.spyOn(client, 'captureException');
    setClient(client);

    const boundary = new AllStakErrorBoundary({ children: null });
    const error = new Error('component crash');
    const errorInfo = { componentStack: '\n    at BrokenComponent\n    at App', digest: undefined };

    boundary.componentDidCatch(error, errorInfo);

    expect(captureSpy).toHaveBeenCalledWith(error, {
      componentStack: errorInfo.componentStack,
      mechanism: 'react-error-boundary',
    });
  });

  it('calls onError prop when provided', () => {
    const onError = vi.fn();
    const boundary = new AllStakErrorBoundary({ children: null, onError });
    const error = new Error('test');

    boundary.componentDidCatch(error, { componentStack: '', digest: undefined });

    expect(onError).toHaveBeenCalledWith(error, '');
  });

  it('renders children when no error', () => {
    const boundary = new AllStakErrorBoundary({ children: React.createElement('div', null, 'hello') });
    boundary.state = { error: null };
    const result = boundary.render();
    expect(result).toBeTruthy();
  });

  it('renders null fallback when error and no fallback provided', () => {
    const boundary = new AllStakErrorBoundary({ children: React.createElement('div') });
    boundary.state = { error: new Error('fail') };
    const result = boundary.render();
    expect(result).toBeNull();
  });

  it('renders static fallback when error', () => {
    const fallback = React.createElement('span', null, 'Something went wrong');
    const boundary = new AllStakErrorBoundary({ children: React.createElement('div'), fallback });
    boundary.state = { error: new Error('fail') };
    const result = boundary.render();
    expect(result).toBe(fallback);
  });

  it('renders function fallback when error', () => {
    const fallback = (err: Error) => React.createElement('span', null, err.message);
    const boundary = new AllStakErrorBoundary({ children: React.createElement('div'), fallback });
    const error = new Error('dynamic fail');
    boundary.state = { error };
    const result = boundary.render() as React.ReactElement;
    expect(result).toBeTruthy();
    expect(result.props.children).toBe('dynamic fail');
  });
});

describe('withAllStakErrorBoundary', () => {
  it('creates a wrapped component with displayName', () => {
    const Inner: React.FC<{ title: string }> = () => null;
    Inner.displayName = 'Inner';
    const Wrapped = withAllStakErrorBoundary(Inner);
    expect(Wrapped.displayName).toBe('withAllStakErrorBoundary(Inner)');
  });
});
