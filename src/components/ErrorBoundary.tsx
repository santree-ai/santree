/**
 * Top-level React error boundary — the last line of defense. It catches any
 * render/lifecycle error not handled by the router's per-route boundary and
 * shows the friendly `ErrorScreen` instead of a blank page or a raw stack.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

import { ErrorScreen } from "./ErrorScreen";

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log for diagnostics; the user only ever sees the friendly screen.
    console.error("Uncaught UI error:", error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return <ErrorScreen error={this.state.error} onRetry={this.reset} />;
    }
    return this.props.children;
  }
}
