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

export function CloseIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
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

export function LoopIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <path d="M4 9a8 8 0 0 1 13.6-3.6L20 8" />
      <path d="M20 4v4h-4" />
      <path d="M20 15a8 8 0 0 1-13.6 3.6L4 16" />
      <path d="M4 20v-4h4" />
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

export function MoreIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </IconShell>
  )
}

export function ChevronIcon(props: IconProps & { direction?: 'left' | 'right' | 'down' | 'up' }): JSX.Element {
  const direction = props.direction ?? 'right'
  const path =
    direction === 'left'
      ? 'M15 18l-6-6 6-6'
      : direction === 'down'
        ? 'M6 9l6 6 6-6'
        : direction === 'up'
          ? 'M18 15l-6-6-6 6'
          : 'M9 6l6 6-6 6'
  return (
    <IconShell {...props}>
      <path d={path} />
    </IconShell>
  )
}

export function PluginIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <path d="M5 7h4V5.5a2.5 2.5 0 0 1 5 0V7h4v4h1.5a2.5 2.5 0 0 1 0 5H19v4h-4v-1.5a2.5 2.5 0 0 0-5 0V20H6a1 1 0 0 1-1-1v-4H3.5a2.5 2.5 0 0 1 0-5H5z" />
    </IconShell>
  )
}

export function SettingsIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
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

/** Phase 38: open-folder glyph for an expanded project row. */
export function FolderOpenIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <path d="M3 7a1 1 0 0 1 1-1h4l2 2h6a1 1 0 0 1 1 1v1" />
      <path d="M3 7v11a1 1 0 0 0 1 1h12.5a1 1 0 0 0 .95-.68L21 10H6.2a1 1 0 0 0-.95.68z" />
    </IconShell>
  )
}

/** Phase 37: Gaia = Earth. A globe glyph for the OpenCode agent. */
export function GlobeIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.5 3.8 5.7 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3z" />
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

// Phase 43: a filled rounded square for the composer's Stop state (icon-only).
export function StopIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2.4" fill="currentColor" stroke="none" />
    </IconShell>
  )
}

// Phase 43: Companions (personality-driven companion agents) — orbit/heart mark.
export function CompanionsIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <circle cx="12" cy="9" r="3.2" />
      <path d="M6 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" />
      <circle cx="19" cy="6" r="1.4" />
    </IconShell>
  )
}

// Phase 43: Agents (coding agents / nodes) — connected-nodes mark.
export function AgentsIcon(props: IconProps): JSX.Element {
  return (
    <IconShell {...props}>
      <circle cx="6" cy="7" r="2.2" />
      <circle cx="18" cy="7" r="2.2" />
      <circle cx="12" cy="17" r="2.2" />
      <path d="M7.6 8.6l3 6.2M16.4 8.6l-3 6.2M8.2 7h7.6" />
    </IconShell>
  )
}

