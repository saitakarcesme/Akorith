interface IconProps {
  size?: number
  className?: string
}

function IconShell({
  size = 16,
  className,
  children
}: IconProps & { children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function PanelsIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4v16" />
      <path d="M15 4v16" />
    </IconShell>
  )
}

export function ChartIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="M8 16v-5" />
      <path d="M12 16V8" />
      <path d="M16 16v-7" />
    </IconShell>
  )
}

export function FlaskIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <path d="M9 3h6" />
      <path d="M10 3v5l-5 8.5A3 3 0 0 0 7.6 21h8.8a3 3 0 0 0 2.6-4.5L14 8V3" />
      <path d="M8 15h8" />
    </IconShell>
  )
}

export function FolderIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <path d="M3.5 6.5h6l1.8 2H20a1.5 1.5 0 0 1 1.5 1.5v7.5A2.5 2.5 0 0 1 19 20H5a2.5 2.5 0 0 1-2.5-2.5V8A1.5 1.5 0 0 1 3.5 6.5Z" />
    </IconShell>
  )
}

export function MessageIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 4v-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
    </IconShell>
  )
}

export function PlusIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </IconShell>
  )
}

export function ChevronIcon(props: IconProps & { direction?: 'left' | 'right' | 'down' }): JSX.Element {
  const direction = props.direction ?? 'right'
  const path = direction === 'left' ? 'M15 18l-6-6 6-6' : direction === 'down' ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'
  return (
    <IconShell {...props}>
      <path d={path} />
    </IconShell>
  )
}

export function SettingsIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
      <path d="M18.5 13.5v-3l-2-.5a6 6 0 0 0-.8-1.9l1-1.8-2.1-2.1-1.8 1a6 6 0 0 0-1.9-.8l-.5-2h-3l-.5 2a6 6 0 0 0-1.9.8l-1.8-1-2.1 2.1 1 1.8a6 6 0 0 0-.8 1.9l-2 .5v3l2 .5a6 6 0 0 0 .8 1.9l-1 1.8 2.1 2.1 1.8-1a6 6 0 0 0 1.9.8l.5 2h3l.5-2a6 6 0 0 0 1.9-.8l1.8 1 2.1-2.1-1-1.8a6 6 0 0 0 .8-1.9l2-.5Z" />
    </IconShell>
  )
}

export function UserIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </IconShell>
  )
}

export function MountainIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <path d="M3 19h18" />
      <path d="M5 19l6.5-13 3.5 7 2-3 4 9" />
      <path d="M10.3 8.4l2.3 2.1 1.3-1.1" />
    </IconShell>
  )
}

export function WaveIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <path d="M3 16c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2" />
      <path d="M3 20c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2" />
      <path d="M4 10c3-3.5 7-5 12-5" />
    </IconShell>
  )
}

export function SparkIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <path d="M12 3l1.7 5.1L19 10l-5.3 1.9L12 17l-1.7-5.1L5 10l5.3-1.9L12 3Z" />
      <path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z" />
    </IconShell>
  )
}

export function SendIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <path d="M4 12l16-8-5 16-3-6-8-2Z" />
      <path d="M12 14l8-10" />
    </IconShell>
  )
}
