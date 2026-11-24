import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { Select as BaseSelect } from '@base-ui/react/select'
import { Switch as BaseSwitch } from '@base-ui/react/switch'
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import { Check, ChevronsUpDown } from 'lucide-react'
import {
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
  forwardRef,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { cn } from '@/lib/format'

/* ---- Button ---------------------------------------------------------------- */

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'md' | 'sm' | 'icon'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', className, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'btn pressable',
        variant === 'primary' && 'btn-primary',
        variant === 'ghost' && 'btn-ghost',
        variant === 'danger' && 'btn-ghost btn-danger',
        size === 'sm' && 'btn-sm',
        size === 'icon' && 'btn-icon',
        className,
      )}
      {...props}
    />
  )
})

/* ---- Tooltip --------------------------------------------------------------- */

export const TooltipProvider = BaseTooltip.Provider

/** Wraps one element. The first tooltip waits; neighbours then open instantly. */
export function Tooltip({ label, children }: { label: string; children: ReactElement<Record<string, unknown>> }) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner sideOffset={8} className="z-[60]">
          <BaseTooltip.Popup className="tooltip">{label}</BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}

export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(function IconButton(
  { label, children, ...props },
  ref,
) {
  return (
    <Tooltip label={label}>
      <Button ref={ref} size="icon" variant="ghost" aria-label={label} {...props}>
        {children}
      </Button>
    </Tooltip>
  )
})

/* ---- Segmented control ----------------------------------------------------- */

interface SegmentedProps<T extends string> {
  label: string
  value: T
  /** `label` may be an icon; `name` then gives the option its accessible name. */
  options: { value: T; label: ReactNode; name?: string; hint?: string }[]
  onChange: (value: T) => void
  className?: string
}

/**
 * The thumb slides on a pointer change only. Arrow keys move it at once: keyboard
 * actions are never animated.
 */
export function Segmented<T extends string>({ label, value, options, onChange, className }: SegmentedProps<T>) {
  const [animate, setAnimate] = useState(false)
  const index = Math.max(0, options.findIndex((o) => o.value === value))
  const width = `calc((100% - 4px) / ${options.length})`
  return (
    <div className={cn('segmented', className)} role="radiogroup" aria-label={label} data-animate={animate}>
      <span
        className="segmented-thumb"
        style={{ width, transform: `translateX(${index * 100}%)` }}
        aria-hidden="true"
      />
      {options.map((option, i) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          aria-label={option.name}
          title={option.hint}
          tabIndex={option.value === value ? 0 : -1}
          className="segmented-option press"
          onPointerDown={() => setAnimate(true)}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
            const next = options[i + step]
            if (!step || !next) return
            event.preventDefault()
            setAnimate(false)
            onChange(next.value)
            const group = event.currentTarget.parentElement
            ;(group?.querySelectorAll('button')[i + step] as HTMLButtonElement | undefined)?.focus()
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/* ---- Switch ---------------------------------------------------------------- */

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
      className="switch"
    >
      <BaseSwitch.Thumb className="switch-thumb" />
    </BaseSwitch.Root>
  )
}

/* ---- Select ---------------------------------------------------------------- */

export interface SelectOption {
  value: string
  label: string
  description?: string
  group?: string
  disabled?: boolean
  trailing?: ReactNode
}

interface SelectProps {
  label: string
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  className?: string
  renderValue?: (option: SelectOption | undefined) => ReactNode
  minWidth?: number
  /** Make the list exactly as wide as the trigger: for a window too narrow for anything wider. */
  fitTrigger?: boolean
}

export function Select({ label, value, options, onChange, className, renderValue, minWidth = 180, fitTrigger }: SelectProps) {
  const groups: { name: string; options: SelectOption[] }[] = []
  for (const option of options) {
    const name = option.group ?? ''
    const group = groups.find((g) => g.name === name)
    if (group) group.options.push(option)
    else groups.push({ name, options: [option] })
  }
  const selected = options.find((o) => o.value === value)
  return (
    <BaseSelect.Root value={value} onValueChange={(next) => next !== null && onChange(String(next))}>
      <BaseSelect.Trigger aria-label={label} className={cn('btn pressable justify-between gap-2', className)}>
        <span className="truncate">{renderValue ? renderValue(selected) : (selected?.label ?? label)}</span>
        <BaseSelect.Icon className="text-faint">
          <ChevronsUpDown size={13} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={6} alignItemWithTrigger={false} className="z-50 outline-none">
          <BaseSelect.Popup
            className="popup p-1"
            style={
              fitTrigger
                ? { width: 'var(--anchor-width)' }
                : { minWidth: `max(var(--anchor-width), ${minWidth}px)`, maxWidth: 'var(--available-width)' }
            }
          >
            <BaseSelect.List className="max-h-[min(var(--available-height),420px)] overflow-y-auto">
              {groups.map((group) => (
                <BaseSelect.Group key={group.name || 'default'}>
                  {group.name && (
                    <BaseSelect.GroupLabel className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">
                      {group.name}
                    </BaseSelect.GroupLabel>
                  )}
                  {group.options.map((option) => (
                    <BaseSelect.Item key={option.value} value={option.value} disabled={option.disabled} className="menu-item">
                      <span className="w-3.5 flex-none text-accent-fg">
                        <BaseSelect.ItemIndicator>
                          <Check size={13} />
                        </BaseSelect.ItemIndicator>
                      </span>
                      <span className="min-w-0 flex-1">
                        <BaseSelect.ItemText className="block truncate">{option.label}</BaseSelect.ItemText>
                        {option.description && (
                          <span className="block max-w-[340px] truncate text-[12px] text-muted">{option.description}</span>
                        )}
                      </span>
                      {option.trailing}
                    </BaseSelect.Item>
                  ))}
                </BaseSelect.Group>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}

/* ---- Dialog ---------------------------------------------------------------- */

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
}

export function Dialog({ open, onOpenChange, title, description, children, footer }: DialogProps) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="dialog-backdrop z-40" />
        <BaseDialog.Popup className="dialog z-40">
          <BaseDialog.Title className="m-0 text-[15px] font-semibold">{title}</BaseDialog.Title>
          {description && (
            <BaseDialog.Description className="mt-1.5 mb-0 text-muted">{description}</BaseDialog.Description>
          )}
          {children && <div className="mt-4">{children}</div>}
          {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

/* ---- Progress -------------------------------------------------------------- */

export function ProgressBar({ value, indeterminate, color }: { value: number; indeterminate?: boolean; color?: string }) {
  const clamped = Math.min(1, Math.max(0, value))
  const previous = useRef(clamped)
  const wentDown = clamped < previous.current
  useLayoutEffect(() => {
    previous.current = clamped
  }, [clamped])
  return (
    <div
      className="progress-track"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(clamped * 100)}
    >
      <div
        className={cn('progress-fill', indeterminate && 'progress-indeterminate')}
        data-reset={wentDown}
        style={indeterminate ? { background: color } : { transform: `scaleX(${clamped})`, background: color }}
      />
    </div>
  )
}

/* ---- Auto-sizing text input ------------------------------------------------ */

/** A text field that commits on blur or Enter, so typing does not fire a request per key. */
export function CommitInput({
  value,
  onCommit,
  commitUnchanged = false,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & {
  value: string
  onCommit: (value: string) => void
  /**
   * Enter commits what the field shows even when it is unchanged, for a value shown rounded
   * (bar 1, kept to a tenth of a millisecond, shows milliseconds): the owner of the field
   * compares the numbers. Leaving the field still commits only a change.
   */
  commitUnchanged?: boolean
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useLayoutEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])
  return (
    <input
      {...props}
      className={cn('input', props.className)}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => {
        focused.current = true
      }}
      onBlur={() => {
        focused.current = false
        if (draft !== value) onCommit(draft)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          if (commitUnchanged && draft === value) onCommit(draft)
          event.currentTarget.blur()
        }
        if (event.key === 'Escape') {
          setDraft(value)
          requestAnimationFrame(() => (event.target as HTMLInputElement).blur())
        }
      }}
    />
  )
}
