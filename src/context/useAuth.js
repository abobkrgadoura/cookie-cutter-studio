import { createContext, useContext } from 'react'

/**
 * Raw auth context + consumer hook, split out of `AuthContext.jsx` so that
 * file's only export stays the provider. See `useSettings.js` for why that
 * split is required for React Fast Refresh.
 */
export const AuthContext = createContext(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
