import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Sicherheitsnetz gegen White-Screen-Crashes: fängt Render-Fehler eines
 * gesamten Tabs ab und bietet eine kontrollierte Wiederherstellung an.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('UI-Fehler abgefangen:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '14px',
          color: 'var(--text-secondary)',
          textAlign: 'center',
          padding: '24px',
        }}>
          <h2 style={{ color: '#ff7b78', fontFamily: 'var(--font-heading)' }}>
            Ups — hier ist etwas schiefgelaufen
          </h2>
          <p style={{ maxWidth: '520px', lineHeight: 1.5, fontSize: '0.9rem' }}>
            {this.state.error.message}
          </p>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button className="btn-secondary" onClick={() => this.setState({ error: null })}>
              Erneut versuchen
            </button>
            <button className="btn-primary" onClick={() => window.location.reload()}>
              App neu laden
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
