import { useCallback, useEffect, useState } from 'react'

const DISPLAY_NAME_KEY = 'akorith.displayName'
const PROFILE_PHOTO_KEY = 'akorith.profilePhoto'
const PROFILE_EVENT = 'akorith:profile-identity'

export interface ProfileIdentity {
  displayName: string
  profilePhoto: string | null
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function readProfileIdentity(): ProfileIdentity {
  return {
    displayName: readStorage(DISPLAY_NAME_KEY)?.trim() || 'Ibrahim',
    profilePhoto: readStorage(PROFILE_PHOTO_KEY)
  }
}

function persistProfileIdentity(identity: ProfileIdentity): void {
  try {
    localStorage.setItem(DISPLAY_NAME_KEY, identity.displayName)
    if (identity.profilePhoto) localStorage.setItem(PROFILE_PHOTO_KEY, identity.profilePhoto)
    else localStorage.removeItem(PROFILE_PHOTO_KEY)
  } catch {
    /* The in-memory identity remains usable when storage is unavailable. */
  }
  window.dispatchEvent(new CustomEvent<ProfileIdentity>(PROFILE_EVENT, { detail: identity }))
}

export function useProfileIdentity(): {
  identity: ProfileIdentity
  updateIdentity: (patch: Partial<ProfileIdentity>) => void
} {
  const [identity, setIdentity] = useState<ProfileIdentity>(readProfileIdentity)

  useEffect(() => {
    const syncFromStorage = (): void => setIdentity(readProfileIdentity())
    const syncFromEvent = (event: Event): void => {
      setIdentity((event as CustomEvent<ProfileIdentity>).detail)
    }
    window.addEventListener('storage', syncFromStorage)
    window.addEventListener(PROFILE_EVENT, syncFromEvent)
    return () => {
      window.removeEventListener('storage', syncFromStorage)
      window.removeEventListener(PROFILE_EVENT, syncFromEvent)
    }
  }, [])

  const updateIdentity = useCallback((patch: Partial<ProfileIdentity>): void => {
    const next = { ...readProfileIdentity(), ...patch }
    persistProfileIdentity(next)
    setIdentity(next)
  }, [])

  return { identity, updateIdentity }
}

export async function profilePhotoFromFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.')
  if (file.size > 10 * 1024 * 1024) throw new Error('Profile photos must be smaller than 10 MB.')

  let source: ImageBitmap | HTMLImageElement
  try {
    source = await createImageBitmap(file)
  } catch {
    // The renderer CSP intentionally disallows blob: image URLs. A data URL is
    // the safe fallback for formats Chromium can decode but createImageBitmap
    // rejects on a particular platform.
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('The selected image could not be read.'))
      reader.onerror = () => reject(new Error('The selected image could not be read.'))
      reader.readAsDataURL(file)
    })
    source = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('The selected image could not be read. Choose a PNG, JPEG, or WebP image.'))
      image.src = dataUrl
    })
  }

  try {
    const sourceWidth = source instanceof ImageBitmap ? source.width : source.naturalWidth
    const sourceHeight = source instanceof ImageBitmap ? source.height : source.naturalHeight
    if (!sourceWidth || !sourceHeight) throw new Error('The selected image has no readable dimensions.')
    const sourceSize = Math.min(sourceWidth, sourceHeight)
    const sourceX = Math.max(0, (sourceWidth - sourceSize) / 2)
    const sourceY = Math.max(0, (sourceHeight - sourceSize) / 2)
    const canvas = document.createElement('canvas')
    canvas.width = 384
    canvas.height = 384
    const context = canvas.getContext('2d')
    if (!context) throw new Error('The profile photo could not be prepared.')
    context.drawImage(source, sourceX, sourceY, sourceSize, sourceSize, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/webp', 0.88)
  } finally {
    if (source instanceof ImageBitmap) source.close()
  }
}
