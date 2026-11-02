import { Circle, ClipboardPaste, Copy, Eraser, Group, MousePointer2, Pencil, PenLine, Spline, Square, Ungroup } from 'lucide-react'
import { useVectorEditor } from '../../../context/useVectorEditor.js'
import { selectionEditState, VECTOR_TOOLS } from '../../../lib/vectorEntities.js'

const ICONS = {
  select: MousePointer2,
  draw: Pencil,
  line: PenLine,
  rect: Square,
  circle: Circle,
  eraser: Eraser,
  node: Spline,
}

const toolButtonClass = (active) =>
  `flex h-10 w-10 shrink-0 items-center justify-center rounded-md transition-colors ${
    active
      ? 'bg-violet-500/20 text-violet-400'
      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-input-hover)] hover:text-[var(--text-primary)]'
  }`

function EditButton({ label, title, disabled, onClick, children }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="flex h-11 w-11 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-input-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
      <span className="text-[8px] leading-none">{label}</span>
    </button>
  )
}

export function DrawingToolbar({ activeTool, onTool }) {
  const {
    entities,
    selectedEntityIds,
    copySelected,
    paste,
    canPaste,
    groupSelected,
    ungroupSelected,
  } = useVectorEditor()
  const edit = selectionEditState(entities, selectedEntityIds)

  return (
    <div className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-[var(--border)] bg-[var(--bg-sidebar)] py-2">
      {VECTOR_TOOLS.map((tool) => {
        const Icon = ICONS[tool.id]
        const active = activeTool === tool.id
        return (
          <button
            key={tool.id}
            type="button"
            aria-label={tool.label}
            aria-pressed={active}
            title={tool.label}
            onClick={() => onTool(tool.id)}
            className={toolButtonClass(active)}
          >
            <Icon size={18} />
          </button>
        )
      })}
      <div className="my-1 h-px w-8 bg-[var(--border)]" />
      <EditButton label="Copy" title="Copy (Ctrl+C)" disabled={!selectedEntityIds.length} onClick={copySelected}>
        <Copy size={15} />
      </EditButton>
      <EditButton label="Paste" title="Paste (Ctrl+V)" disabled={!canPaste} onClick={paste}>
        <ClipboardPaste size={15} />
      </EditButton>
      <EditButton label="Group" title="Group (Ctrl+G)" disabled={!edit.canGroup} onClick={groupSelected}>
        <Group size={15} />
      </EditButton>
      <EditButton label="Ungroup" title="Ungroup (Ctrl+Shift+G)" disabled={!edit.canUngroup} onClick={ungroupSelected}>
        <Ungroup size={15} />
      </EditButton>
    </div>
  )
}
