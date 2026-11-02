import { createContext, useContext } from 'react'

/**
 * The raw context object + consumer hook, split out of `SettingsContext.jsx`
 * into their own plain (non-JSX) module.
 *
 * Vite's React Fast Refresh treats a `.jsx` module as a safe HMR boundary
 * only when EVERY export is a component — a context+hook file that also
 * exports a `*Provider` component fails that check even though `useSettings`
 * is a perfectly normal hook (this is a documented upstream limitation, see
 * https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-react#consistent-components-exports).
 * Keeping the context object and hook here, and `SettingsProvider` as the
 * *only* export of `SettingsContext.jsx`, lets edits to either file hot-swap
 * in place instead of forcing a full page reload.
 */
export const SettingsContext = createContext(null)

export function useSettings() {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider')
  return ctx
}
