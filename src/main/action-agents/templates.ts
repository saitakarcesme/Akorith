import type { AgentPermissionMode } from './types'

// Phase 52: built-in agent templates. Each is a starting point the user can create
// an agent from. Defaults lean safe (preview / ask_write).

export interface AgentTemplate {
  id: string
  name: string
  description: string
  icon: string
  category: string
  defaultPermission: AgentPermissionMode
  allowCommands: boolean
  /** Whether it operates on a selected folder/project. */
  needsRoot: boolean
  /** The task instruction handed to the local model planner. */
  goal: string
  /** Honest note when a capability isn't fully supported yet. */
  note?: string
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'desktop_organizer',
    name: 'Desktop Organizer',
    description: 'Group files in a folder into tidy subfolders by type/date. Preview first, never deletes.',
    icon: 'folder',
    category: 'files',
    defaultPermission: 'preview',
    allowCommands: false,
    needsRoot: true,
    goal: 'Analyze the chosen folder and propose grouping its loose files into subfolders by type and date. Never delete anything; only propose moves/new folders. Always preview first.'
  },
  {
    id: 'repo_health',
    name: 'Repo Health Checker',
    description: 'Analyze a repo and write a health report suggesting tests, docs, and refactors.',
    icon: 'stethoscope',
    category: 'code',
    defaultPermission: 'safe_writes',
    allowCommands: false,
    needsRoot: true,
    goal: 'Inspect the selected repository and produce a concise health report artifact: structure, missing tests/docs, risky areas, and 5 concrete improvement suggestions.'
  },
  {
    id: 'test_writer',
    name: 'Test Writer',
    description: 'Inspect a repo and generate tests for key modules.',
    icon: 'flask',
    category: 'code',
    defaultPermission: 'ask_write',
    allowCommands: true,
    needsRoot: true,
    goal: 'Inspect the repository and generate meaningful tests for one important module. Propose the test files as writes; suggest a validation command to run them.'
  },
  {
    id: 'readme_builder',
    name: 'README Builder',
    description: 'Create or improve a project README.',
    icon: 'doc',
    category: 'docs',
    defaultPermission: 'ask_write',
    allowCommands: false,
    needsRoot: true,
    goal: 'Create or improve the README for the selected project: title, description, install, usage, and a short roadmap. Propose it as a single README.md write.'
  },
  {
    id: 'changelog_maker',
    name: 'Changelog Maker',
    description: 'Read git log and draft a changelog.',
    icon: 'list',
    category: 'docs',
    defaultPermission: 'safe_commands',
    allowCommands: true,
    needsRoot: true,
    goal: 'Read the recent git log (git log) and draft a human-readable CHANGELOG.md grouped by type. Propose it as a write artifact.'
  },
  {
    id: 'pdf_summarizer',
    name: 'PDF Summarizer',
    description: 'Summarize PDFs in a folder.',
    icon: 'doc',
    category: 'files',
    defaultPermission: 'preview',
    allowCommands: false,
    needsRoot: true,
    goal: 'Summarize the PDF documents in the selected folder into a single summary artifact.',
    note: 'PDF text extraction is not yet wired — this template produces the framework + a summary report from available metadata/filenames and is marked unsupported for full PDF parsing.'
  },
  {
    id: 'demo_script',
    name: 'Demo Video Script Writer',
    description: 'Write a demo script from project notes/screenshots.',
    icon: 'film',
    category: 'docs',
    defaultPermission: 'safe_writes',
    allowCommands: false,
    needsRoot: true,
    goal: 'Analyze the project (README, structure, any docs/screenshots names) and write a 60–90 second demo video script artifact.'
  },
  {
    id: 'benchmark_helper',
    name: 'Local Model Benchmark Helper',
    description: 'Create a benchmark plan/report for local models.',
    icon: 'gauge',
    category: 'ai',
    defaultPermission: 'preview',
    allowCommands: false,
    needsRoot: false,
    goal: 'Produce a benchmark plan artifact for evaluating local models: tasks, prompts, scoring rubric, and a results table template.'
  },
  {
    id: 'commit_assistant',
    name: 'Git Commit Assistant',
    description: 'Review the diff and suggest commit messages.',
    icon: 'git',
    category: 'code',
    defaultPermission: 'safe_commands',
    allowCommands: true,
    needsRoot: true,
    goal: 'Read the current git diff (git diff) and suggest 3 clear conventional-commit messages in a report artifact.'
  },
  {
    id: 'folder_analyzer',
    name: 'Folder Analyzer',
    description: 'Summarize a folder structure and large files.',
    icon: 'folder',
    category: 'files',
    defaultPermission: 'preview',
    allowCommands: false,
    needsRoot: true,
    goal: 'Summarize the selected folder: structure overview, notable/large files, and observations, as a report artifact.'
  }
]

export function templateById(id: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((t) => t.id === id)
}
