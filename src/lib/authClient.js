import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Fallback gracefully if env vars are missing so the app doesn't crash.
// persistSession writes the Supabase session to localStorage so a reload
// stays signed in. autoRefreshToken renews it before it expires.
export const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: window.localStorage,
      },
    })
  : null

/** Session written by the Supabase client (`sb-<project-ref>-auth-token`). */
function persistedSession() {
  if (typeof window === 'undefined') return null
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (!key?.startsWith('sb-') || !key.endsWith('-auth-token')) continue
      const raw = window.localStorage.getItem(key)
      if (!raw) continue
      const session = JSON.parse(raw)
      if (session?.access_token && session?.user) return session
    }
  } catch {
    return null
  }
  return null
}

/** User from the persisted session, available on the first paint after refresh. */
export function readPersistedUser() {
  return userFromSession(persistedSession())
}

export function userFromSession(session) {
  const authUser = session?.user
  if (!authUser?.email) return null
  return { email: authUser.email, provider: 'supabase', user: authUser }
}

function normalizeEmail(email) {
  const trimmed = String(email ?? '').trim().toLowerCase()
  if (!trimmed || !trimmed.includes('@')) {
    throw new Error('Enter a valid email address')
  }
  return trimmed
}

export async function signInWithEmail(email, password) {
  if (!supabase) throw new Error('Supabase is not configured. Please add .env variables.')
  const { data, error } = await supabase.auth.signInWithPassword({
    email: normalizeEmail(email),
    password,
  })
  if (error) throw error
  return userFromSession(data.session)
}

export async function signUpWithEmail(email, password) {
  if (!supabase) throw new Error('Supabase is not configured. Please add .env variables.')
  const { data, error } = await supabase.auth.signUp({
    email: normalizeEmail(email),
    password,
  })
  if (error) throw error
  return userFromSession(data.session) ?? (data.user?.email
    ? { email: data.user.email, provider: 'supabase', user: data.user }
    : null)
}

export async function signOutSession() {
  if (supabase) await supabase.auth.signOut()
  return null
}

/** Updates the password on the current Supabase session. */
export async function updateUserPassword(password) {
  if (!supabase) throw new Error('Supabase is not configured. Please add .env variables.')
  const next = String(password ?? '')
  if (next.length < 6) throw new Error('Password must be at least 6 characters.')
  const { error } = await supabase.auth.updateUser({ password: next })
  if (error) throw error
}
