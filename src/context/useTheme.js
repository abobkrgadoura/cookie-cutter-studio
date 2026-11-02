import { createContext, useContext } from 'react'

/**
 * The raw context object + consumer hook, split out of `ThemeContext.jsx`
 * into their own plain (non-JSX) module — see `useSettings.js` for why
 * this split is necessary for React Fast Refresh to hot-swap this context
 * without forcing a full page reload.
 */
export const ThemeContext = createContext(null)

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
