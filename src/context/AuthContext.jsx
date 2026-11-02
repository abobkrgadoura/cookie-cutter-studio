import { useCallback, useEffect, useMemo, useState } from 'react'
import { readPersistedUser, signInWithEmail, signOutSession, signUpWithEmail, supabase, updateUserPassword, userFromSession } from '../lib/authClient.js'
import { AuthContext } from './useAuth.js'

/**
 * Holds the signed-in email session. The public shape stays
 * `user`, `signIn`, `signUp`, and `signOut`. The Supabase session itself
 * is restored from localStorage on load.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(readPersistedUser)
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(false)
  const [authModalOpen, setAuthModalOpen] = useState(false)

  useEffect(() => {
    if (!supabase) return undefined
    let cancelled = false

    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setUser(userFromSession(data.session))
    })

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!cancelled) setUser(userFromSession(session))
    })

    return () => {
      cancelled = true
      subscription.subscription.unsubscribe()
    }
  }, [])

  const run = useCallback(async (action) => {
    setPending(true)
    setError(null)
    try {
      const session = await action()
      setUser(session)
      return session
    } catch (err) {
      const message = err?.message || 'Sign-in failed'
      setError(message)
      throw err
    } finally {
      setPending(false)
    }
  }, [])

  const signIn = useCallback((email, password) => run(() => signInWithEmail(email, password)), [run])

  const signUp = useCallback((email, password) => run(() => signUpWithEmail(email, password)), [run])

  const signOut = useCallback(() => run(() => signOutSession()), [run])

  const updatePassword = useCallback(async (password) => {
    await updateUserPassword(password)
  }, [])

  const openAuthModal = useCallback(() => {
    setError(null)
    setAuthModalOpen(true)
  }, [])

  const closeAuthModal = useCallback(() => {
    setAuthModalOpen(false)
  }, [])

  const value = useMemo(
    () => ({
      user,
      error,
      pending,
      signIn,
      signUp,
      signOut,
      updatePassword,
      authModalOpen,
      openAuthModal,
      closeAuthModal,
    }),
    [user, error, pending, signIn, signUp, signOut, updatePassword, authModalOpen, openAuthModal, closeAuthModal],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
