import { supabase } from './authClient'

export async function saveDesignToCloud(name, settings) {
  if (!supabase) return null
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('You must be logged in to save designs.')

  const { data, error } = await supabase
    .from('designs')
    .insert([{ user_id: user.id, name, settings }])
    .select()

  if (error) throw error
  return data[0]
}

export async function getUserDesigns() {
  if (!supabase) return []
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const { data, error } = await supabase
    .from('designs')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) throw error
  return data
}

/**
 * Removes every cloud design saved under `designName` for `userId`.
 * The designs table has no id column, so user_id + name is the row key.
 * Profile save inserts a new row each time, so a delete clears all of them.
 */
export async function deleteDesignFromCloud(userId, designName) {
  if (!supabase) throw new Error('Supabase is not configured.')
  if (userId == null || userId === '' || designName == null || designName === '') {
    throw new Error('Cannot delete a design without a user and a name.')
  }

  const { error } = await supabase
    .from('designs')
    .delete()
    .eq('user_id', userId)
    .eq('name', designName)

  if (error) throw error
}

function normalizeProfile(row) {
  const isPro = row?.is_pro === true || row?.plan_tier === 'pro'
  return {
    ...(row || {}),
    is_pro: isPro,
    plan_tier: isPro ? 'pro' : 'free',
  }
}

export async function getUserProfile() {
  if (!supabase) return { plan_tier: 'free', is_pro: false }
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { plan_tier: 'free', is_pro: false }

  let { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (error || !data) {
    // Auto-create a free profile if the signup trigger has not inserted one yet.
    const { data: newData } = await supabase
      .from('profiles')
      .insert([{ id: user.id, plan_tier: 'free', is_pro: false }])
      .select('*')
      .single()
    return normalizeProfile(newData)
  }
  return normalizeProfile(data)
}

export async function updateUserProfile(userId, updates) {
  if (!supabase) throw new Error('Supabase is not configured.')
  if (!userId) throw new Error('You must be logged in to update your profile.')

  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', userId)
    .select('*')
    .single()

  if (error) throw error
  return normalizeProfile(data)
}

export async function uploadAvatar(userId, file) {
  if (!supabase) throw new Error('Supabase is not configured.')
  if (!userId) throw new Error('You must be logged in to upload an avatar.')
  if (!file) throw new Error('Choose an image to upload.')

  const ext = String(file.name ?? '').split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'png'
  const filePath = `${userId}/avatar.${ext}`
  const { error } = await supabase.storage.from('avatars').upload(filePath, file, {
    upsert: true,
    contentType: file.type || undefined,
  })
  if (error) throw error

  const { data } = supabase.storage.from('avatars').getPublicUrl(filePath)
  if (!data?.publicUrl) throw new Error('Could not resolve the avatar URL.')
  return `${data.publicUrl}?v=${Date.now()}`
}

export async function deleteDesignById(designId) {
  if (!supabase) throw new Error('Supabase is not configured.')
  const { data, error } = await supabase
    .from('designs')
    .delete()
    .eq('id', designId)
    .select('id') // MANDATORY to detect RLS blocks or missing rows

  if (error) throw error
  if (!data || data.length === 0) {
    throw new Error('Supabase refused to delete. Row not found or blocked by RLS.')
  }
}
