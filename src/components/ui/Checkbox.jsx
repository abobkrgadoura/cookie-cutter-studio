export function Checkbox({ checked, onChange, label, children }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-[var(--text-primary)]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-violet-600"
      />
      {label}
      {children}
    </label>
  )
}
