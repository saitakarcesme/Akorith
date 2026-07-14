interface ProfileAvatarProps {
  name: string
  photo: string | null
  size?: 'small' | 'large'
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return 'A'
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('')
}

export function ProfileAvatar({ name, photo, size = 'small' }: ProfileAvatarProps): JSX.Element {
  return (
    <span className={`profile-avatar is-${size}`} aria-hidden="true">
      {photo ? <img src={photo} alt="" /> : <span>{initialsFor(name)}</span>}
    </span>
  )
}
