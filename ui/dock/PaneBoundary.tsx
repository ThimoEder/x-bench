import { Component } from "react";
import type { ReactNode } from "react";

export interface PaneBoundaryProps {
  // Names the pane in the message, for example "This session".
  label: string;
  // A change clears the error without remounting the pane, for example the focused session's id.
  resetKey?: unknown;
  children?: ReactNode;
}

interface PaneBoundaryState {
  failed: boolean;
  message: string;
  resetKey: unknown;
}

// Keeps a render error inside one pane, so the rest of the window stays usable.
export class PaneBoundary extends Component<PaneBoundaryProps, PaneBoundaryState> {
  state: PaneBoundaryState = { failed: false, message: "", resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<PaneBoundaryState> {
    return { failed: true, message: error instanceof Error ? error.message : String(error) };
  }

  static getDerivedStateFromProps(props: PaneBoundaryProps, state: PaneBoundaryState): Partial<PaneBoundaryState> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null;
    return { failed: false, message: "", resetKey: props.resetKey };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="pane-error" role="alert" data-testid="pane-error">
        <p className="pane-error-title">{this.props.label} could not be shown.</p>
        {this.state.message ? <p className="pane-error-detail">{this.state.message}</p> : null}
        <button type="button" onClick={() => this.setState({ failed: false, message: "" })}>
          Try again
        </button>
      </div>
    );
  }
}
