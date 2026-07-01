import type { ReactNode } from 'react'
import { CloseIcon } from './icons'

type ButtonVariant = 'primary' | 'secondary' | 'danger'

interface ButtonProps {
  children: ReactNode
  type?: 'button' | 'submit'
  disabled?: boolean
  title?: string
  className?: string
  onClick?: () => void
}

interface CommandModalProps {
  children: ReactNode
  ariaLabel: string
  onClose: () => void
  safeToClose?: boolean
  width?: 'standard' | 'wide'
}

function modalWidthClass(width: CommandModalProps['width']): string {
  return width === 'wide' ? 'is-wide' : 'is-standard'
}

export function CommandModal({
  children,
  ariaLabel,
  onClose,
  safeToClose = true,
  width = 'standard'
}: CommandModalProps): JSX.Element {
  return (
    <div
      className="command-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && safeToClose) onClose()
      }}
    >
      <section
        className={`command-modal ${modalWidthClass(width)}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </section>
    </div>
  )
}

export function ModalHeader({
  title,
  subtitle,
  eyebrow,
  onClose,
  closeDisabled = false
}: {
  title: string
  subtitle?: string
  eyebrow?: string
  onClose: () => void
  closeDisabled?: boolean
}): JSX.Element {
  return (
    <header className="command-modal-header">
      <div>
        {eyebrow && <span className="command-modal-eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <IconButton label="Close dialog" title="Close" disabled={closeDisabled} onClick={onClose}>
        <CloseIcon size={16} />
      </IconButton>
    </header>
  )
}

export function ModalFooter({ children }: { children: ReactNode }): JSX.Element {
  return <footer className="command-modal-footer">{children}</footer>
}

export function ModalBody({ children }: { children: ReactNode }): JSX.Element {
  return <div className="command-modal-body">{children}</div>
}

export function FormGrid({ children, columns = 2 }: { children: ReactNode; columns?: 1 | 2 | 3 }): JSX.Element {
  return <div className={`form-grid is-${columns}`}>{children}</div>
}

export function FieldLabel({
  label,
  hint,
  children,
  className
}: {
  label: string
  hint?: string
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <label className={`field-label ${className ?? ''}`.trim()}>
      <span>{label}</span>
      {children}
      {hint && <em>{hint}</em>}
    </label>
  )
}

function ActionButton({ variant, children, className, ...props }: ButtonProps & { variant: ButtonVariant }): JSX.Element {
  return (
    <button type={props.type ?? 'button'} className={`action-button is-${variant} ${className ?? ''}`.trim()} {...props}>
      {children}
    </button>
  )
}

export function PrimaryButton(props: ButtonProps): JSX.Element {
  return <ActionButton {...props} variant="primary" />
}

export function SecondaryButton(props: ButtonProps): JSX.Element {
  return <ActionButton {...props} variant="secondary" />
}

export function DangerButton(props: ButtonProps): JSX.Element {
  return <ActionButton {...props} variant="danger" />
}

export function IconButton({
  label,
  children,
  className,
  ...props
}: Omit<ButtonProps, 'children'> & {
  label: string
  children: ReactNode
}): JSX.Element {
  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      className={`icon-button ${className ?? ''}`.trim()}
      aria-label={label}
      title={props.title ?? label}
    >
      {children}
    </button>
  )
}

/**
 * Phase 55.060: the one composer send/stop control, shared by the normal chat
 * (ChatPanel) and the Companion composer so they are visually identical. It
 * renders the existing `.send-button` circle (44px, --accent, scale-on-active,
 * .is-stop danger) — icon-only, no text label.
 */
export function ComposerSendButton({
  stop = false,
  disabled = false,
  onClick,
  children
}: {
  stop?: boolean
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      className={`send-button ${stop ? 'is-stop' : ''}`.trim()}
      disabled={disabled}
      onClick={onClick}
      aria-label={stop ? 'Stop generation' : 'Send message'}
      title={stop ? 'Stop generation' : 'Send message'}
    >
      {children}
    </button>
  )
}

export function ComposerActionButton({
  label,
  children,
  className,
  active = false,
  ...props
}: Omit<ButtonProps, 'children'> & {
  label: string
  children: ReactNode
  active?: boolean
}): JSX.Element {
  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      className={`composer-action-button ${active ? 'is-active' : ''} ${className ?? ''}`.trim()}
      aria-label={label}
      title={props.title ?? label}
    >
      {children}
    </button>
  )
}
