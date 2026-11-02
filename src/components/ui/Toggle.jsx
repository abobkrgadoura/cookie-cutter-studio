export function Toggle({ checked, onChange, labelledBy }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-[34px] shrink-0 rounded-full transition-colors duration-300 ease-in-out ${
        checked ? 'bg-violet-600' : 'bg-[var(--toggle-off)]'
      }`}
    >
      <span
        className={`absolute top-[2px] left-[2px] h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-transform duration-300 ease-in-out ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  )
}
