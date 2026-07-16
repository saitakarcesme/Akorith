import { ipcMain } from 'electron'

export interface GitHubContributionDay {
  date: string
  count: number
  level: number
}

export interface GitHubActivity {
  username: string
  days: GitHubContributionDay[]
  total: number
  fetchedAt: number
}

const CACHE_TTL_MS = 15 * 60 * 1000
const cache = new Map<string, GitHubActivity>()

function attribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]
}

function parseContributionPage(html: string): GitHubContributionDay[] {
  const days: GitHubContributionDay[] = []
  const cellPattern = /(<td\b[^>]*\bContributionCalendar-day\b[^>]*><\/td>)\s*(<tool-tip\b[^>]*>[\s\S]*?<\/tool-tip>)/g
  for (const match of html.matchAll(cellPattern)) {
    const tag = match[1]
    const tooltip = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const date = attribute(tag, 'data-date')
    const level = Number(attribute(tag, 'data-level') ?? 0)
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const countMatch = tooltip.match(/([\d,]+) contributions?\b/i)
    const count = countMatch ? Number(countMatch[1].replace(/,/g, '')) : 0
    days.push({ date, count: Number.isFinite(count) ? count : 0, level: Math.max(0, Math.min(4, level)) })
  }
  return days
}

async function fetchYear(username: string, year: number): Promise<GitHubContributionDay[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetch(
      `https://github.com/users/${encodeURIComponent(username)}/contributions?from=${year}-01-01&to=${year}-12-31`,
      {
        headers: {
          Accept: 'text/html',
          'User-Agent': 'Akorith-Desktop'
        },
        signal: controller.signal
      }
    )
    if (!response.ok) throw new Error(`GitHub activity request failed (${response.status})`)
    return parseContributionPage(await response.text())
  } finally {
    clearTimeout(timer)
  }
}

export async function getGitHubActivity(usernameInput: unknown): Promise<GitHubActivity> {
  const username = typeof usernameInput === 'string' ? usernameInput.trim() : ''
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(username)) {
    throw new Error('Invalid GitHub username.')
  }
  const key = username.toLowerCase()
  const cached = cache.get(key)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached

  const year = new Date().getFullYear()
  const pages = await Promise.all([fetchYear(username, year - 1), fetchYear(username, year)])
  const byDate = new Map<string, GitHubContributionDay>()
  for (const day of pages.flat()) byDate.set(day.date, day)
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  const activity: GitHubActivity = {
    username,
    days,
    total: days.reduce((sum, day) => sum + day.count, 0),
    fetchedAt: Date.now()
  }
  cache.set(key, activity)
  return activity
}

export function registerGitHubActivityIpc(): void {
  ipcMain.handle('githubActivity:get', (_event, username: unknown) => getGitHubActivity(username))
}
