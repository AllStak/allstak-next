import * as React from 'react';
import { getClient } from './client';

export interface AllStakErrorBoundaryProps {
  fallback?: React.ReactNode | ((error: Error) => React.ReactNode);
  onError?: (error: Error, componentStack: string) => void;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class AllStakErrorBoundary extends React.Component<AllStakErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: AllStakErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    const componentStack = errorInfo.componentStack || '';
    try {
      const client = getClient();
      if (client) {
        client.captureException(error, {
          componentStack,
          mechanism: 'react-error-boundary',
        });
      }
    } catch {
      // fail-open
    }

    this.props.onError?.(error, componentStack);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      const { fallback } = this.props;
      if (typeof fallback === 'function') {
        return fallback(this.state.error);
      }
      if (fallback !== undefined) {
        return fallback;
      }
      return null;
    }
    return this.props.children;
  }
}

export function withAllStakErrorBoundary<P extends Record<string, unknown>>(
  Component: React.ComponentType<P>,
  boundaryProps?: Omit<AllStakErrorBoundaryProps, 'children'>,
): React.FC<P> {
  const Wrapped: React.FC<P> = (props: P) => {
    return React.createElement(
      AllStakErrorBoundary,
      { ...boundaryProps, children: React.createElement(Component, props) } as AllStakErrorBoundaryProps,
    );
  };
  Wrapped.displayName = `withAllStakErrorBoundary(${Component.displayName || Component.name || 'Component'})`;
  return Wrapped;
}
