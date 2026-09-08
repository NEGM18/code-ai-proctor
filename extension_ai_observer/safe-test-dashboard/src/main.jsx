import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthProvider } from './lib/auth/AuthContext.jsx'
import { TelemetryProvider } from './lib/telemetry/index.js'
import './styles/theme.css'
import App from './App.jsx'

// ⚠ TELEMETRY SITS *INSIDE* AuthProvider, NOT BESIDE IT AND NOT AROUND IT.
// TelemetryProvider calls `useAuth()` to mirror sign-in/sign-out into
// posthog.identify()/reset(), and that hook throws by design when there is no
// <AuthProvider> above it. Consuming the existing context is also the point:
// subscribing to supabase.auth.onAuthStateChange a second time would race the
// first, and the two subscribers would disagree about whether a user is signed
// in — which shows up as identify() and reset() fighting over the same session.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <TelemetryProvider>
        <App />
      </TelemetryProvider>
    </AuthProvider>
  </StrictMode>,
)
