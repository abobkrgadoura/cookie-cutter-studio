import { createContext, useContext } from 'react'

/**
 * The raw context object + consumer hook, split out of `ModelContext.jsx`
 * into their own plain (non-JSX) module — see `useSettings.js` for why
 * this split is necessary for React Fast Refresh to hot-swap this context
 * without forcing a full page reload.
 */
export const ModelContext = createContext(null)

export function useModel() {
  const ctx = useContext(ModelContext)
  if (!ctx) throw new Error('useModel must be used within a ModelProvider')
  return ctx
}
