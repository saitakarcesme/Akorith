import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { SendOptions, SendResult } from './providers/types'
import {
  estimateTokens,
  providerRuntimeWatchdog,
  redactCliText,
  runCli
} from './providers/util'

export const BEYEFENDI_MODEL_ID = 'beyefendi-v2-hf'
export const BEYEFENDI_REPO_ID = 'Ibrahimsait/Beyefendi-v2'
export const BEYEFENDI_BASE_MODEL = 'Qwen/Qwen3.5-9B'

const REQUIRED_ADAPTER_FILES = [
  'adapter_config.json',
  'adapter_model.safetensors',
  'chat_beyefendi.py',
  'chat_template.jinja',
  'requirements.txt',
  'tokenizer_config.json'
] as const
const READY_MARKER = '.akorith-runtime-ready.json'
const RUNNER_FILE = 'akorith_beyefendi_runner.py'
const STREAM_BEGIN = '__AKORITH_BEYEFENDI_BEGIN__'
const STREAM_END = '__AKORITH_BEYEFENDI_END__'
const SETUP_TIMEOUT_MS = 30 * 60_000
const GENERATION_TIMEOUT_MS = 20 * 60_000

const BEYEFENDI_RUNNER = `from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

adapter = Path(sys.argv[1]).resolve(strict=True)
payload = json.load(sys.stdin)
script_path = adapter / "chat_beyefendi.py"
spec = importlib.util.spec_from_file_location("akorith_beyefendi_chat", script_path)
if spec is None or spec.loader is None:
    raise RuntimeError("Beyefendi launcher could not be loaded.")
chat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chat)

original_render_prompt = chat.render_prompt


def render_prompt_compat(tokenizer, history, torch):
    rendered = original_render_prompt(tokenizer, history, torch)
    if hasattr(rendered, "get"):
        input_ids = rendered.get("input_ids")
        if input_ids is not None:
            return input_ids
    return rendered


chat.render_prompt = render_prompt_compat

args = SimpleNamespace(
    max_new_tokens=int(payload.get("max_new_tokens", 768)),
    temperature=float(payload.get("temperature", 0.35)),
    top_p=float(payload.get("top_p", 0.9)),
    repetition_penalty=float(payload.get("repetition_penalty", 1.05)),
)
prompt = str(payload.get("prompt", "")).strip()
if not prompt:
    raise RuntimeError("Prompt cannot be empty.")

model, tokenizer, torch = chat.load_model(adapter, online=True)
history = [
    {"role": "system", "content": chat.SYSTEM_PROMPT},
    {"role": "user", "content": prompt},
]
print("${STREAM_BEGIN}", flush=True)
chat.generate(model, tokenizer, torch, history, args)
print("${STREAM_END}", flush=True)
`

export interface BeyefendiRuntimeStatus {
  repoId: typeof BEYEFENDI_REPO_ID
  modelId: typeof BEYEFENDI_MODEL_ID
  baseModel: typeof BEYEFENDI_BASE_MODEL
  adapterDir: string
  adapterDownloaded: boolean
  runtimeReady: boolean
  available: boolean
  stage: 'not_installed' | 'adapter_downloaded' | 'ready'
  note: string
}

export interface BeyefendiSetupResult {
  ok: boolean
  status: BeyefendiRuntimeStatus
  error?: string
}

function adapterDir(): string {
  const electronApp = app as unknown as { getPath?: (name: 'userData') => string } | undefined
  const userData = electronApp && typeof electronApp.getPath === 'function'
    ? electronApp.getPath('userData')
    : process.platform === 'win32'
      ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Akorith')
      : join(homedir(), '.config', 'Akorith')
  return join(userData, 'models', 'beyefendi-v2')
}

function runtimePython(directory = adapterDir()): string {
  return process.platform === 'win32'
    ? join(directory, '.venv', 'Scripts', 'python.exe')
    : join(directory, '.venv', 'bin', 'python')
}

function adapterDownloaded(directory = adapterDir()): boolean {
  return REQUIRED_ADAPTER_FILES.every((file) => existsSync(join(directory, file)))
}

export function getBeyefendiRuntimeStatus(): BeyefendiRuntimeStatus {
  const directory = adapterDir()
  const downloaded = adapterDownloaded(directory)
  const ready =
    downloaded &&
    existsSync(runtimePython(directory)) &&
    existsSync(join(directory, RUNNER_FILE)) &&
    existsSync(join(directory, READY_MARKER))
  const stage = ready ? 'ready' : downloaded ? 'adapter_downloaded' : 'not_installed'
  return {
    repoId: BEYEFENDI_REPO_ID,
    modelId: BEYEFENDI_MODEL_ID,
    baseModel: BEYEFENDI_BASE_MODEL,
    adapterDir: directory,
    adapterDownloaded: downloaded,
    runtimeReady: ready,
    available: ready,
    stage,
    note: ready
      ? 'Ready in Akorith Local through the private Hugging Face PEFT runtime.'
      : downloaded
        ? 'The private adapter is downloaded. Finish local CUDA runtime setup to use it.'
        : 'Install the private adapter and its isolated CUDA runtime.'
  }
}

function conciseFailure(stdout: string, stderr: string): string {
  const value = redactCliText(`${stderr}\n${stdout}`)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join(' ')
  return value.slice(0, 900) || 'The local runtime command failed without an error message.'
}

async function checked(
  command: string,
  args: string[],
  options: Parameters<typeof runCli>[2]
): Promise<void> {
  const result = await runCli(command, args, options)
  if (result.code !== 0) {
    throw new Error(conciseFailure(result.stdout, result.stderr))
  }
}

let setupInFlight: Promise<BeyefendiSetupResult> | null = null

async function setupBeyefendiRuntimeFresh(): Promise<BeyefendiSetupResult> {
  const directory = adapterDir()
  mkdirSync(directory, { recursive: true })
  try {
    if (process.platform === 'darwin') {
      throw new Error('Beyefendi-v2 requires the CUDA/4-bit launcher from its private model card; this runtime is not available on macOS.')
    }
    await checked('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
      timeoutMs: 20_000,
      excludedExecutableDirectory: null
    })
    await checked(
      'hf',
      [
        'download',
        BEYEFENDI_REPO_ID,
        ...REQUIRED_ADAPTER_FILES,
        '--local-dir',
        directory
      ],
      {
        cwd: directory,
        excludedExecutableDirectory: null,
        timeoutMs: SETUP_TIMEOUT_MS
      }
    )

    writeFileSync(join(directory, RUNNER_FILE), BEYEFENDI_RUNNER, 'utf8')
    const python = runtimePython(directory)
    if (!existsSync(python)) {
      await checked('uv', ['venv', join(directory, '.venv'), '--python', '3.11', '--seed'], {
        cwd: directory,
        excludedExecutableDirectory: null,
        timeoutMs: 5 * 60_000
      })
    }
    await checked(
      'uv',
      [
        'pip',
        'install',
        '--python',
        python,
        'torch',
        '--index-url',
        'https://download.pytorch.org/whl/cu128'
      ],
      {
        cwd: directory,
        excludedExecutableDirectory: null,
        timeoutMs: SETUP_TIMEOUT_MS,
        env: { UV_LINK_MODE: 'copy' }
      }
    )
    await checked(
      'uv',
      ['pip', 'install', '--python', python, '-r', join(directory, 'requirements.txt')],
      {
        cwd: directory,
        excludedExecutableDirectory: null,
        timeoutMs: SETUP_TIMEOUT_MS,
        env: { UV_LINK_MODE: 'copy' }
      }
    )
    await checked(
      python,
      [
        join(directory, 'chat_beyefendi.py'),
        '--adapter',
        directory,
        '--check-only',
        '--online'
      ],
      {
        cwd: directory,
        excludedExecutableDirectory: null,
        timeoutMs: 10 * 60_000
      }
    )
    writeFileSync(
      join(directory, READY_MARKER),
      JSON.stringify({
        schemaVersion: 1,
        repoId: BEYEFENDI_REPO_ID,
        modelId: BEYEFENDI_MODEL_ID,
        configuredAt: Date.now()
      }, null, 2),
      'utf8'
    )
    return { ok: true, status: getBeyefendiRuntimeStatus() }
  } catch (error) {
    return {
      ok: false,
      status: getBeyefendiRuntimeStatus(),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function setupBeyefendiRuntime(): Promise<BeyefendiSetupResult> {
  if (setupInFlight) return setupInFlight
  const request = setupBeyefendiRuntimeFresh()
  setupInFlight = request
  return request.finally(() => {
    if (setupInFlight === request) setupInFlight = null
  })
}

function positiveInteger(value: number | undefined, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback
}

function temperature(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, 2)
    : 0.35
}

function extractStream(stdout: string): string {
  const start = stdout.indexOf(STREAM_BEGIN)
  if (start < 0) return ''
  const bodyStart = start + STREAM_BEGIN.length
  const end = stdout.indexOf(STREAM_END, bodyStart)
  return (end < 0 ? stdout.slice(bodyStart) : stdout.slice(bodyStart, end))
    .replace(/^\r?\n/, '')
    .replace(/\r?\n\r?\n$/, '\n')
    .trim()
}

export async function sendBeyefendi(
  prompt: string,
  opts: SendOptions,
  onToken: (token: string) => void
): Promise<SendResult> {
  const status = getBeyefendiRuntimeStatus()
  if (!status.available) {
    throw new Error('Beyefendi-v2 is not ready. Open Settings → Providers and finish its Local setup first.')
  }
  const directory = status.adapterDir
  const payload = JSON.stringify({
    prompt,
    max_new_tokens: positiveInteger(opts.generation?.maxTokens, 768, 4_096),
    temperature: temperature(opts.generation?.temperature),
    top_p: 0.9,
    repetition_penalty: 1.05
  })
  let streamed = ''
  let pending = ''
  let inside = false
  let ended = false
  const keep = Math.max(STREAM_BEGIN.length, STREAM_END.length)
  const flush = (force = false): void => {
    if (!inside || ended) return
    const endIndex = pending.indexOf(STREAM_END)
    if (endIndex >= 0) {
      const value = pending.slice(0, endIndex).replace(/\r?\n$/, '')
      if (value) {
        streamed += value
        onToken(value)
      }
      pending = ''
      ended = true
      return
    }
    const emitLength = force ? pending.length : Math.max(0, pending.length - keep)
    if (emitLength > 0) {
      const value = pending.slice(0, emitLength)
      pending = pending.slice(emitLength)
      streamed += value
      onToken(value)
    }
  }

  const result = await runCli(
    runtimePython(directory),
    [join(directory, RUNNER_FILE), directory],
    {
      stdin: payload,
      signal: opts.signal,
      timeoutMs: GENERATION_TIMEOUT_MS,
      cwd: opts.workingDirectory ?? directory,
      excludedExecutableDirectory: opts.workingDirectory ?? null,
      env: {
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8'
      },
      ...providerRuntimeWatchdog('local', 'Beyefendi-v2', opts.onActivity),
      onStdoutChunk: (chunk) => {
        pending += chunk
        if (!inside) {
          const start = pending.indexOf(STREAM_BEGIN)
          if (start < 0) {
            pending = pending.slice(-keep)
            return
          }
          pending = pending.slice(start + STREAM_BEGIN.length).replace(/^\r?\n/, '')
          inside = true
        }
        flush()
      }
    }
  )
  flush(true)
  if (result.code !== 0) {
    throw new Error(`Beyefendi-v2 failed: ${conciseFailure(result.stdout, result.stderr)}`)
  }
  const text = (streamed || extractStream(result.stdout)).trim()
  if (!text) throw new Error('Beyefendi-v2 completed without a text response.')
  if (!streamed) onToken(text)
  return {
    text,
    usage: {
      promptTokens: estimateTokens(prompt),
      completionTokens: estimateTokens(text),
      totalTokens: estimateTokens(prompt) + estimateTokens(text),
      costUsd: 0,
      estimated: true
    },
    model: BEYEFENDI_MODEL_ID,
    raw: {
      runtime: 'huggingface-peft',
      repoId: BEYEFENDI_REPO_ID,
      baseModel: BEYEFENDI_BASE_MODEL
    }
  }
}

export function readBeyefendiReadyMarker(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(adapterDir(), READY_MARKER), 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}
