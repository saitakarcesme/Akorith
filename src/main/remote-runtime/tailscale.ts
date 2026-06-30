import { execFile } from 'child_process'
import { existsSync } from 'fs'

// Phase 42 (Remote Ollama): optional Tailscale peer discovery so the Mac can find
// the PC's Ollama (100.x:11434) when away from the home LAN. Read-only: it shells
// out to the user's already-installed `tailscale` CLI. It NEVER installs Tailscale,
// changes any setting, or exposes anything publicly. Only private CGNAT (100.64/10)
// IPv4 peer addresses are surfaced. Tokens/keys are never read or logged.

export interface TailscalePeer {
  hostName: string
  dnsName?: string
  /** First Tailscale IPv4 (100.64.0.0/10). */
  ip: string
  online: boolean
  os?: string
  isSelf: boolean
}

export interface TailscaleStatus {
  installed: boolean
  running: boolean
  /** Short reason when not usable (for setup guidance; never includes secrets). */
  note?: string
  peers: TailscalePeer[]
}

const COMMON_TAILSCALE_PATHS = [
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/bin/tailscale'
]

function resolveTailscaleBin(): string {
  for (const p of COMMON_TAILSCALE_PATHS) {
    if (existsSync(p)) return p
  }
  // Fall back to PATH resolution (execFile with bare name).
  return 'tailscale'
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, stdout: (stdout ?? '').toString() })
    })
  })
}

function isCgnatV4(ip: string): boolean {
  // Tailscale assigns 100.64.0.0/10 IPv4 addresses.
  const m = ip.match(/^(\d+)\.(\d+)\.\d+\.\d+$/)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  return a === 100 && b >= 64 && b <= 127
}

function firstCgnatV4(ips: unknown): string | undefined {
  if (!Array.isArray(ips)) return undefined
  for (const ip of ips) {
    if (typeof ip === 'string' && isCgnatV4(ip)) return ip
  }
  return undefined
}

/** Read-only `tailscale status --json`. Never throws; returns a safe summary. */
export async function getTailscaleStatus(): Promise<TailscaleStatus> {
  const bin = resolveTailscaleBin()

  const version = await run(bin, ['version'], 4_000)
  if (!version.ok) {
    return { installed: false, running: false, note: 'Tailscale CLI not found. Install Tailscale on both machines and sign in.', peers: [] }
  }

  const status = await run(bin, ['status', '--json'], 6_000)
  if (!status.ok || !status.stdout.trim()) {
    return { installed: true, running: false, note: 'Tailscale is installed but not running or not signed in. Open Tailscale and connect.', peers: [] }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(status.stdout) as Record<string, unknown>
  } catch {
    return { installed: true, running: false, note: 'Could not parse Tailscale status.', peers: [] }
  }

  const peers: TailscalePeer[] = []
  const self = parsed.Self as Record<string, unknown> | undefined
  if (self) {
    const ip = firstCgnatV4(self.TailscaleIPs)
    if (ip) {
      peers.push({
        hostName: String(self.HostName ?? 'this-mac'),
        dnsName: typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : undefined,
        ip,
        online: self.Online === true,
        os: typeof self.OS === 'string' ? self.OS : undefined,
        isSelf: true
      })
    }
  }

  const peerMap = (parsed.Peer as Record<string, Record<string, unknown>> | undefined) ?? {}
  for (const peer of Object.values(peerMap)) {
    const ip = firstCgnatV4(peer.TailscaleIPs)
    if (!ip) continue
    peers.push({
      hostName: String(peer.HostName ?? 'peer'),
      dnsName: typeof peer.DNSName === 'string' ? peer.DNSName.replace(/\.$/, '') : undefined,
      ip,
      online: peer.Online === true,
      os: typeof peer.OS === 'string' ? peer.OS : undefined,
      isSelf: false
    })
  }

  const reachablePeers = peers.filter((p) => !p.isSelf)
  return {
    installed: true,
    running: true,
    note: reachablePeers.length === 0 ? 'Tailscale is connected but no peer devices were found. Sign the PC into the same tailnet.' : undefined,
    peers
  }
}

/**
 * Candidate Ollama base URLs from Tailscale peers (excluding self), preferring
 * online non-macOS peers (the PC). Bounded to a handful; no scanning.
 */
export async function tailscaleOllamaCandidates(): Promise<{ baseUrl: string; hostName: string; online: boolean }[]> {
  const status = await getTailscaleStatus()
  if (!status.installed || !status.running) return []
  return status.peers
    .filter((p) => !p.isSelf)
    .sort((a, b) => Number(b.online) - Number(a.online))
    .slice(0, 6)
    .map((p) => ({ baseUrl: `http://${p.ip}:11434`, hostName: p.hostName, online: p.online }))
}
