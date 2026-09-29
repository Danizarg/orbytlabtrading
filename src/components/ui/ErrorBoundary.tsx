'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RotateCw } from 'lucide-react';

interface Props {
  /** Name of the panel, used in the fallback message. */
  label: string;
  children: ReactNode;
  /** Optional custom fallback. */
  fallback?: (reset: () => void, error: Error) => ReactNode;
  /** When any value changes, the boundary resets (e.g. the token mint). */
  resetKeys?: readonly unknown[];
  className?: string;
}

interface State {
  error: Error | null;
  keys: readonly unknown[] | undefined;
}

/**
 * Panel-level error boundary: a crash in one panel (bad provider payload,
 * chart error) never blanks the rest of the terminal.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, keys: this.props.resetKeys };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    const changed =
      props.resetKeys !== undefined &&
      (state.keys === undefined ||
        props.resetKeys.length !== state.keys.length ||
        props.resetKeys.some((k, i) => !Object.is(k, state.keys?.[i])));
    return changed ? { error: null, keys: props.resetKeys } : null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ORBYT] ${this.props.label} crashed`, error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.reset, error);
    return (
      <div role="alert" className={this.props.className ?? 'flex h-full min-h-24 flex-col items-center justify-center gap-2 p-4 text-center'}>
        <p className="text-xs text-fg-dim">{this.props.label} failed to render.</p>
        <button
          type="button"
          onClick={this.reset}
          className="inline-flex items-center gap-1.5 rounded-md border border-line-strong px-2.5 py-1 text-2xs text-muted hover:bg-hover hover:text-fg"
        >
          <RotateCw className="size-3" /> Retry
        </button>
      </div>
    );
  }
}
