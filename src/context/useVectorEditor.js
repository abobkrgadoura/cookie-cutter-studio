import { createContext, useContext } from 'react'

/**
 * Split from `VectorEditorContext.jsx` so that file's only export is the
 * provider component and Vite can fast-refresh it. Same split as
 * `useSettings.js`.
 */
export const VectorEditorContext = createContext(null)

/**
 * The committed drawing as the cutter sees it. Kept apart from the editor
 * context so selection, tool and pan/zoom changes never wake the model
 * builder; this value only changes when the entity list is committed.
 */
export const VectorCamContext = createContext(null)

export function useVectorEditor() {
  const ctx = useContext(VectorEditorContext)
  if (!ctx) throw new Error('useVectorEditor must be used within VectorEditorProvider')
  return ctx
}

export function useVectorCam() {
  const ctx = useContext(VectorCamContext)
  if (!ctx) throw new Error('useVectorCam must be used within VectorEditorProvider')
  return ctx
}
