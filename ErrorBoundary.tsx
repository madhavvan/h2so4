// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ErrorBoundary — last-resort React render-error catch
//
//  v4.0.0 release blocker addressed (2026-05-09 audit): the app
//  shipped with no error boundaries anywhere, so a single render
//  error in the new ProviderIcons / drop zone / custom-instructions
//  modal code paths would white-screen the entire app for any of
//  the 2M+ users on the new build. This component catches render
//  errors below it, logs them for diagnostics, and presents a
//  minimal recovery UI ("Reload app" button) instead.
//
//  Class component (not hook-based) because React's error-handling
//  hooks don't yet exist in stable — `getDerivedStateFromError` and
//  `componentDidCatch` are still class-only.
//
//  Scope: wraps MainApp at the top of App.tsx's render. Auth flows
//  and the SubscriptionGate render OUTSIDE the boundary (they're
//  the parents) — fine, those are simple flat surfaces with low
//  render-error risk. The boundary specifically protects the chat
//  composer, modal stack, popout, and ProviderIcons rendering.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Log to the console for any user that has DevTools open + to
    // stderr in Electron's main-process console. Future hook: ship
    // to a crash-reporter service (Sentry / similar). Kept local for
    // v4.0.0 since we don't want to add a new outbound network
    // dependency in this release.
    console.error('[ErrorBoundary] Render error:', error);
    console.error('[ErrorBoundary] Component stack:', info.componentStack);
  }

  handleReload = () => {
    // Full reload — simpler and more reliable than trying to recover
    // mid-state. The chat-history / settings persist via localStorage
    // + Electron SQLite, so the user resumes where they left off.
    if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
      window.location.reload();
    } else {
      this.setState({ error: null });
    }
  };

  render() {
    if (this.state.error) {
      return (
        <div
          role="alert"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            background: '#0a0a0f',
            color: '#e4e4e7',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            padding: '24px',
            textAlign: 'center',
          }}
        >
          <div style={{ maxWidth: 480 }}>
            <div
              style={{
                fontSize: '14px',
                fontWeight: 600,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: '#f87171',
                marginBottom: 12,
              }}
            >
              Something went wrong
            </div>
            <h1 style={{ fontSize: '22px', fontWeight: 600, margin: '0 0 12px 0' }}>
              The app hit an unexpected error.
            </h1>
            <p style={{ fontSize: '14px', lineHeight: 1.6, color: '#a1a1aa', margin: '0 0 24px 0' }}>
              Your chat history, settings, and uploaded files are safe — they're persisted locally.
              Reloading the app should bring you right back.
            </p>
            <button
              onClick={this.handleReload}
              style={{
                background: '#3b82f6',
                color: '#ffffff',
                border: 'none',
                padding: '10px 24px',
                borderRadius: '10px',
                fontSize: '14px',
                fontWeight: 600,
                cursor: 'pointer',
                boxShadow: '0 4px 14px rgba(59, 130, 246, 0.35)',
              }}
            >
              Reload app
            </button>
            {this.state.error?.message && (
              <details style={{ marginTop: 24, color: '#71717a', fontSize: '11px' }}>
                <summary style={{ cursor: 'pointer' }}>Error details</summary>
                <pre
                  style={{
                    marginTop: 8,
                    padding: 12,
                    background: 'rgba(255, 255, 255, 0.04)',
                    borderRadius: 8,
                    textAlign: 'left',
                    overflow: 'auto',
                    fontSize: '10.5px',
                    lineHeight: 1.5,
                    maxHeight: 200,
                  }}
                >
                  {this.state.error.message}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
