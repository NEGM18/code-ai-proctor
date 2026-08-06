// =============================================================================
// src/lib/auth/context.js
//
// The context object lives in its own non-JSX module, separate from the
// <AuthProvider> component in AuthContext.jsx. react-refresh/only-export-
// components (eslint-plugin-react-refresh) requires a file that exports a
// component to export ONLY components, or Fast Refresh degrades to a full
// reload on every edit — splitting the context out keeps AuthContext.jsx
// clean for Fast Refresh and lets useAuth.js import the context directly
// without importing the component.
// =============================================================================

import { createContext } from 'react'

export const AuthContext = createContext(undefined)
