export type WorkspaceBrowserAction = {
  type: 'open_project_preview'
  browser: 'chrome' | 'default'
}

export type WorkspaceActionIntent = 'execute' | 'plan' | undefined

export interface WorkspacePreviewOpenInput {
  workspacePath: string
  browser: WorkspaceBrowserAction['browser']
}

export interface WorkspacePreviewOpenResult {
  url: string
}

export interface WorkspaceBrowserActionDependencies {
  opener: (input: WorkspacePreviewOpenInput) => Promise<WorkspacePreviewOpenResult>
}

export type WorkspaceBrowserActionReceipt = WorkspaceBrowserAction & {
  url: string
  label: string
}

export interface WorkspaceBrowserActionError {
  error: string
  label: string
}

export const WORKSPACE_BROWSER_ACTION_INSTRUCTION =
  `When the user explicitly asks to open, launch, show, or preview the workspace site, page, app, or project in a browser, do not run an open, xdg-open, start, or other browser-launch shell command, and do not give the user a manual launch command. Complete the workspace work normally. Akorith's trusted host will start and open the project preview in the requested browser after this turn finishes. Do not claim that opening the browser failed merely because browser-launch shell commands are unavailable.`

const ACTION_PATTERN = /(?:^|[^\p{L}\p{N}_])(?:open|launch|show|preview|aç(?:ar|ın|in|mak|mayı|mayi|masını|masini|manızı|manizi)?|ac(?:ar|in|mak|mayi|masini|manizi)?|göster(?:in|mek|mesini|menizi)?|goster(?:in|mek|mesini|menizi)?|çalıştır(?:ın|mak|mayı|masını|manızı)?|calistir(?:in|mak|mayi|masini|manizi)?|başlat(?:ın|mak|mayı|masını|manızı)?|baslat(?:in|mak|mayi|masini|manizi)?)(?=$|[^\p{L}\p{N}_])/giu
const BROWSER_PATTERN = /(?:^|[^\p{L}\p{N}_])(?:google\s+chrome|chrome|browser|tarayıcı(?:da|de|yı|yi)?|tarayici(?:da|de|yi)?)(?=$|[^\p{L}\p{N}_])/iu
const CHROME_PATTERN = /(?:^|[^\p{L}\p{N}_])(?:google\s+chrome|chrome)(?=$|[^\p{L}\p{N}_])/iu
const TARGET_PATTERN = /(?:^|[^\p{L}\p{N}_])(?:site|website|web\s*site|page|app|application|project|preview|it|this|that|siteyi|sayfa|sayfayı|sayfayi|uygulama|uygulamayı|uygulamayi|proje|projeyi|önizleme|onizleme|onu|bunu)(?=$|[^\p{L}\p{N}_])/iu
const NEGATED_ACTION_PATTERN = /(?:do\s+not|don't|dont|never|should(?:n't|\s+not)|cannot|can't|cant|could(?:n't|\s+not)|without)\s+(?:please\s+)?(?:open|launch|show|preview)\b/iu
const MANUAL_COMMAND_LINE_PATTERN =
  /^(?:(?:example|örnek|ornek)\s*:\s*)?(?:[$>]\s*)?(?:open\s+(?:-[a-z]+\s+|(?:\.{0,2}[\\/]|[~/]|file:|https?:|[\w.-]+\.(?:html?|xhtml)\b))|xdg-open\s+|start(?:\s+chrome)?\s+|google-chrome\s+|chromium\s+)/iu

function withoutManualCommandExamples(prompt: string): string {
  return prompt
    .normalize('NFKC')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .split(/\r?\n/)
    .filter((line) => !MANUAL_COMMAND_LINE_PATTERN.test(line.trim().replace(/^["']|["']$/g, '')))
    .join('\n')
}

function hasExplicitBrowserRequest(text: string): boolean {
  ACTION_PATTERN.lastIndex = 0
  for (const match of text.matchAll(ACTION_PATTERN)) {
    const actionStart = match.index ?? 0
    const contextStart = Math.max(0, actionStart - 100)
    const contextEnd = Math.min(text.length, actionStart + match[0].length + 180)
    const context = text.slice(contextStart, contextEnd)
    if (
      BROWSER_PATTERN.test(context) &&
      TARGET_PATTERN.test(context) &&
      !NEGATED_ACTION_PATTERN.test(context)
    ) {
      return true
    }
  }
  return false
}

export function detectWorkspaceBrowserAction(
  prompt: string,
  intent: WorkspaceActionIntent
): WorkspaceBrowserAction | null {
  if (intent !== 'execute' || typeof prompt !== 'string' || !prompt.trim()) return null
  const request = withoutManualCommandExamples(prompt)
  if (!hasExplicitBrowserRequest(request)) return null
  return {
    type: 'open_project_preview',
    browser: CHROME_PATTERN.test(request) ? 'chrome' : 'default'
  }
}

function actionLabel(browser: WorkspaceBrowserAction['browser'], failed = false): string {
  const target = browser === 'chrome' ? 'Chrome' : 'the default browser'
  return failed ? `Could not open project preview in ${target}` : `Opened project preview in ${target}`
}

export async function runWorkspaceBrowserAction(
  input: {
    prompt: string
    intent: WorkspaceActionIntent
    workspacePath: string
  },
  dependencies: WorkspaceBrowserActionDependencies
): Promise<WorkspaceBrowserActionReceipt | WorkspaceBrowserActionError | null> {
  const action = detectWorkspaceBrowserAction(input.prompt, input.intent)
  if (!action) return null

  if (typeof input.workspacePath !== 'string' || !input.workspacePath.trim()) {
    return {
      error: 'Workspace path is unavailable.',
      label: actionLabel(action.browser, true)
    }
  }

  try {
    const opened = await dependencies.opener({
      workspacePath: input.workspacePath,
      browser: action.browser
    })
    if (!opened || typeof opened.url !== 'string' || !opened.url.trim()) {
      throw new Error('Workspace preview did not return a URL.')
    }
    return {
      ...action,
      url: opened.url,
      label: actionLabel(action.browser)
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      label: actionLabel(action.browser, true)
    }
  }
}
