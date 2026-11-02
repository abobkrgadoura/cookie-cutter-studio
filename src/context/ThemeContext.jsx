import { useEffect, useMemo, useState } from 'react'
import { ThemeContext } from './useTheme.js'

// `ThemeContext` (the raw context object) and `useTheme` (the consumer
// hook) live in `useTheme.js`, not here, so this module's only export is
// the `ThemeProvider` component — see that file's doc comment for why
// that's required for React Fast Refresh to work on this context.

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem('cutter-theme') || 'dark')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('cutter-theme', theme)
  }, [theme])

  const value = useMemo(
    () => ({
      theme,
      isDark: theme === 'dark',
      toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
    }),
    [theme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
