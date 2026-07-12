import type {
  PluginAuthContract,
  PluginCapability,
  PluginCategory,
  PluginConfigField,
  PluginHealthContract,
  PluginIcon,
  PluginManifest,
  PluginPermission
} from './types'
import { assertValidPluginManifest } from './validation'

const PUBLISHER = Object.freeze({ id: 'akorith', name: 'Akorith' })

type CapabilitySeed = readonly [
  suffix: string,
  title: string,
  description: string,
  access: PluginCapability['access']
]

interface CatalogSeed {
  id: string
  name: string
  category: PluginCategory
  description: string
  auth: PluginAuthContract
  networkScopes?: string[]
  capabilities: CapabilitySeed[]
  permissions?: Omit<PluginPermission, 'id'>[]
  configFields?: Record<string, PluginConfigField>
  iconFallback?: PluginIcon['fallback']
  healthProbe?: PluginHealthContract['probe']
}

function credentialAuth(mode: PluginAuthContract['mode'], credentialKind: string, helpUrl?: string): PluginAuthContract {
  return { mode, required: true, credentialKinds: [credentialKind], ...(helpUrl ? { helpUrl } : {}) }
}

function noCredentialAuth(mode: 'none' | 'cli' | 'local-socket' = 'none'): PluginAuthContract {
  return { mode, required: false, credentialKinds: [] }
}

function field(
  type: PluginConfigField['type'],
  title: string,
  description: string,
  required = false,
  options: Pick<PluginConfigField, 'default' | 'choices' | 'min' | 'max'> = {}
): PluginConfigField {
  return { type, title, description, required, ...options }
}

function buildManifest(seed: CatalogSeed): PluginManifest {
  const capabilities = seed.capabilities.map<PluginCapability>(([suffix, title, description, access]) => ({
    id: `${seed.id}.${suffix}`,
    title,
    description,
    access
  }))

  const permissions: PluginPermission[] = []
  if (seed.networkScopes?.length) {
    permissions.push({
      id: `${seed.id}.network`,
      kind: 'network',
      access: 'connect',
      required: true,
      scopes: [...seed.networkScopes],
      risk: 'medium',
      rationale: `Connect only to the declared ${seed.name} service endpoints.`
    })
  }
  if (seed.auth.required) {
    permissions.push({
      id: `${seed.id}.credentials`,
      kind: 'credentials',
      access: 'read',
      required: true,
      scopes: [`vault:${seed.id}`],
      risk: 'high',
      rationale: `Use a ${seed.name} credential only inside its trusted adapter call.`
    })
  }
  for (const permission of seed.permissions ?? []) {
    permissions.push({ ...permission, id: `${seed.id}.${permission.kind}.${permissions.length + 1}` })
  }

  const configFields: Record<string, PluginConfigField> = { ...(seed.configFields ?? {}) }
  if (seed.networkScopes?.[0]?.startsWith('https://') && !configFields.endpoint) {
    configFields.endpoint = field(
      'url',
      'Service endpoint',
      'Adapter endpoint. A changed host still requires a matching explicit network grant.',
      false,
      { default: seed.networkScopes[0] }
    )
  }
  if (seed.auth.required) {
    configFields.credentialRef = field(
      'credential-reference',
      'Credential',
      'Opaque reference to an operating-system-protected credential; no secret is stored in plugin config.',
      true
    )
  }

  const capabilityIds = capabilities.map((capability) => capability.id)
  const permissionIds = permissions.filter((permission) => permission.required).map((permission) => permission.id)
  const localProbe = seed.healthProbe === 'local' || (!seed.healthProbe && !seed.networkScopes?.length && !seed.auth.required)

  const manifest: PluginManifest = {
    schemaVersion: 1,
    id: seed.id,
    name: seed.name,
    publisher: PUBLISHER,
    version: '1.0.0',
    category: seed.category,
    description: seed.description,
    icon: { kind: 'brand', value: seed.id, fallback: seed.iconFallback ?? 'plug' },
    capabilities,
    skills: [
      {
        id: `${seed.id}.skill`,
        label: `${seed.name} workflows`,
        description: `Plan user-approved ${seed.name} work using only declared capabilities.`,
        capabilityIds
      }
    ],
    mcpServers: [
      {
        id: `${seed.id}.mcp`,
        label: `${seed.name} MCP surface`,
        transport: 'adapter',
        availability: localProbe ? 'local-probe' : 'requires-connection',
        capabilityIds
      }
    ],
    hooks: [
      {
        id: `${seed.id}.health-hook`,
        event: 'health-changed',
        description: `Publish verified ${seed.name} health changes to marketplace consumers.`
      }
    ],
    apps: [
      {
        id: `${seed.id}.app`,
        label: seed.name,
        description: `Browse ${seed.name} resources exposed by its connected adapter.`,
        surface: 'panel',
        capabilityIds
      }
    ],
    commands: [
      {
        id: `${seed.id}.open`,
        title: `Open ${seed.name}`,
        description: `Open the ${seed.name} plugin after permissions and connection health are verified.`,
        capabilityIds,
        permissionIds,
        requiresConnection: true
      }
    ],
    permissions,
    configSchema: { version: 1, additionalProperties: false, fields: configFields },
    auth: { ...seed.auth, credentialKinds: [...seed.auth.credentialKinds] },
    health: {
      probe: seed.healthProbe ?? (localProbe ? 'local' : 'adapter'),
      timeoutMs: 10_000,
      staleAfterMs: 60_000,
      initialState: 'disconnected'
    }
  }

  assertValidPluginManifest(manifest)
  return manifest
}

const seeds: CatalogSeed[] = [
  {
    id: 'github',
    name: 'GitHub',
    category: 'source-control',
    description: 'Inspect repositories, issues, pull requests, reviews, and checks through an explicit GitHub connection.',
    auth: credentialAuth('oauth2', 'github-oauth-token'),
    networkScopes: ['https://api.github.com'],
    capabilities: [
      ['repositories.read', 'Read repositories', 'Inspect repository metadata and files.', 'read'],
      ['issues.manage', 'Manage issues', 'Read and update user-selected issues.', 'manage'],
      ['pull-requests.manage', 'Manage pull requests', 'Inspect and update user-selected pull requests.', 'manage']
    ]
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    category: 'source-control',
    description: 'Inspect projects, issues, merge requests, and pipelines through a scoped GitLab connection.',
    auth: credentialAuth('oauth2', 'gitlab-oauth-token'),
    networkScopes: ['https://gitlab.com/api/v4'],
    capabilities: [
      ['projects.read', 'Read projects', 'Inspect project metadata and repository content.', 'read'],
      ['issues.manage', 'Manage issues', 'Read and update user-selected issues.', 'manage'],
      ['merge-requests.manage', 'Manage merge requests', 'Inspect and update user-selected merge requests.', 'manage']
    ]
  },
  {
    id: 'bitbucket',
    name: 'Bitbucket',
    category: 'source-control',
    description: 'Inspect repositories, pull requests, and pipelines through a scoped Bitbucket connection.',
    auth: credentialAuth('oauth2', 'bitbucket-oauth-token'),
    networkScopes: ['https://api.bitbucket.org/2.0'],
    capabilities: [
      ['repositories.read', 'Read repositories', 'Inspect repository metadata and source.', 'read'],
      ['pull-requests.manage', 'Manage pull requests', 'Inspect and update selected pull requests.', 'manage'],
      ['pipelines.read', 'Read pipelines', 'Inspect pipeline status and logs.', 'read']
    ]
  },
  {
    id: 'linear',
    name: 'Linear',
    category: 'project-management',
    description: 'Read and update teams, projects, and issues through a user-authorized Linear workspace connection.',
    auth: credentialAuth('oauth2', 'linear-oauth-token'),
    networkScopes: ['https://api.linear.app/graphql'],
    capabilities: [
      ['issues.manage', 'Manage issues', 'Read and update issues in approved teams.', 'manage'],
      ['projects.read', 'Read projects', 'Inspect project and cycle context.', 'read']
    ]
  },
  {
    id: 'jira',
    name: 'Jira',
    category: 'project-management',
    description: 'Read and update Jira projects and issues on a specifically approved Jira site.',
    auth: credentialAuth('api-token', 'jira-api-token'),
    networkScopes: ['user-selected Jira site only'],
    configFields: {
      endpoint: field('url', 'Jira site', 'Exact Jira site URL covered by the network permission grant.', true),
      accountEmail: field('string', 'Account email', 'Account identifier paired with the protected API token.', true)
    },
    capabilities: [
      ['issues.manage', 'Manage issues', 'Read and update selected Jira issues.', 'manage'],
      ['projects.read', 'Read projects', 'Inspect project metadata and workflows.', 'read']
    ]
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'knowledge',
    description: 'Search and update explicitly shared Notion pages and databases through an integration token.',
    auth: credentialAuth('api-token', 'notion-integration-token'),
    networkScopes: ['https://api.notion.com'],
    capabilities: [
      ['pages.read', 'Read pages', 'Search and read pages shared with the integration.', 'read'],
      ['pages.write', 'Write pages', 'Create or update pages shared with the integration.', 'write'],
      ['databases.read', 'Read databases', 'Query approved Notion databases.', 'read']
    ]
  },
  {
    id: 'slack',
    name: 'Slack',
    category: 'communication',
    description: 'Search approved channels and send user-confirmed messages through a scoped Slack workspace connection.',
    auth: credentialAuth('oauth2', 'slack-oauth-token'),
    networkScopes: ['https://slack.com/api'],
    capabilities: [
      ['messages.read', 'Read messages', 'Search messages in approved channels.', 'read'],
      ['messages.write', 'Send messages', 'Send messages only after explicit user confirmation.', 'write'],
      ['channels.read', 'Read channels', 'List channels visible to the connection.', 'read']
    ]
  },
  {
    id: 'discord',
    name: 'Discord',
    category: 'communication',
    description: 'Read approved Discord channels and send user-confirmed messages through a bot connection.',
    auth: credentialAuth('api-token', 'discord-bot-token'),
    networkScopes: ['https://discord.com/api/v10'],
    capabilities: [
      ['channels.read', 'Read channels', 'List approved guild channels.', 'read'],
      ['messages.read', 'Read messages', 'Read messages from approved channels.', 'read'],
      ['messages.write', 'Send messages', 'Send messages only after explicit user confirmation.', 'write']
    ]
  },
  {
    id: 'gmail',
    name: 'Gmail',
    category: 'productivity',
    description: 'Search mail and create or send user-confirmed drafts through a scoped Google OAuth connection.',
    auth: credentialAuth('oauth2', 'google-oauth-token'),
    networkScopes: ['https://gmail.googleapis.com'],
    capabilities: [
      ['messages.read', 'Read mail', 'Search and read mail covered by granted scopes.', 'read'],
      ['drafts.write', 'Create drafts', 'Create email drafts for user review.', 'write'],
      ['messages.send', 'Send mail', 'Send only after explicit user confirmation.', 'execute']
    ]
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    category: 'productivity',
    description: 'Read calendars and create or update user-confirmed events through Google OAuth.',
    auth: credentialAuth('oauth2', 'google-oauth-token'),
    networkScopes: ['https://www.googleapis.com/calendar/v3'],
    capabilities: [
      ['events.read', 'Read events', 'Inspect events on approved calendars.', 'read'],
      ['events.manage', 'Manage events', 'Create or update user-confirmed calendar events.', 'manage']
    ]
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    category: 'productivity',
    description: 'Search and manage explicitly approved Drive files through a scoped Google OAuth connection.',
    auth: credentialAuth('oauth2', 'google-oauth-token'),
    networkScopes: ['https://www.googleapis.com/drive/v3'],
    capabilities: [
      ['files.read', 'Read files', 'Search and download approved Drive files.', 'read'],
      ['files.write', 'Write files', 'Upload or update files after user approval.', 'write']
    ]
  },
  {
    id: 'figma',
    name: 'Figma',
    category: 'design',
    description: 'Inspect approved Figma files, components, comments, and exports through a scoped connection.',
    auth: credentialAuth('oauth2', 'figma-oauth-token'),
    networkScopes: ['https://api.figma.com'],
    capabilities: [
      ['files.read', 'Read files', 'Inspect approved design files and components.', 'read'],
      ['comments.manage', 'Manage comments', 'Read and add comments with user approval.', 'manage'],
      ['exports.read', 'Export assets', 'Request approved design exports.', 'read']
    ]
  },
  {
    id: 'vercel',
    name: 'Vercel',
    category: 'delivery',
    description: 'Inspect projects and deployments and start user-approved deployments through Vercel.',
    auth: credentialAuth('api-token', 'vercel-access-token'),
    networkScopes: ['https://api.vercel.com'],
    capabilities: [
      ['projects.read', 'Read projects', 'Inspect approved Vercel projects.', 'read'],
      ['deployments.read', 'Read deployments', 'Inspect deployment status and logs.', 'read'],
      ['deployments.execute', 'Start deployments', 'Start deployments only after explicit approval.', 'execute']
    ]
  },
  {
    id: 'netlify',
    name: 'Netlify',
    category: 'delivery',
    description: 'Inspect sites and deploys and start user-approved deploy operations through Netlify.',
    auth: credentialAuth('oauth2', 'netlify-oauth-token'),
    networkScopes: ['https://api.netlify.com/api/v1'],
    capabilities: [
      ['sites.read', 'Read sites', 'Inspect approved Netlify sites.', 'read'],
      ['deploys.read', 'Read deploys', 'Inspect deploy status and logs.', 'read'],
      ['deploys.execute', 'Start deploys', 'Start deploys only after explicit approval.', 'execute']
    ]
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    category: 'delivery',
    description: 'Inspect zones, Workers, and deployments and perform user-approved Cloudflare changes.',
    auth: credentialAuth('api-token', 'cloudflare-api-token'),
    networkScopes: ['https://api.cloudflare.com/client/v4'],
    capabilities: [
      ['zones.read', 'Read zones', 'Inspect approved zones and DNS records.', 'read'],
      ['workers.manage', 'Manage Workers', 'Inspect and update approved Workers.', 'manage'],
      ['deployments.execute', 'Deploy changes', 'Deploy only after explicit approval.', 'execute']
    ]
  },
  {
    id: 'sentry',
    name: 'Sentry',
    category: 'observability',
    description: 'Inspect organizations, projects, issues, and events through a scoped Sentry connection.',
    auth: credentialAuth('api-token', 'sentry-auth-token'),
    networkScopes: ['https://sentry.io/api/0'],
    capabilities: [
      ['issues.read', 'Read issues', 'Inspect issues and event context.', 'read'],
      ['releases.read', 'Read releases', 'Inspect release and deployment health.', 'read'],
      ['issues.manage', 'Manage issues', 'Resolve or assign issues after user approval.', 'manage']
    ]
  },
  {
    id: 'datadog',
    name: 'Datadog',
    category: 'observability',
    description: 'Query approved Datadog metrics, logs, dashboards, and monitors through scoped credentials.',
    auth: credentialAuth('api-token', 'datadog-api-and-app-key'),
    networkScopes: ['https://api.datadoghq.com'],
    capabilities: [
      ['metrics.read', 'Read metrics', 'Query approved metric series.', 'read'],
      ['logs.read', 'Read logs', 'Search logs within approved scopes.', 'read'],
      ['monitors.manage', 'Manage monitors', 'Update monitors only after explicit approval.', 'manage']
    ]
  },
  {
    id: 'posthog',
    name: 'PostHog',
    category: 'analytics',
    description: 'Query approved PostHog events, insights, feature flags, and project metadata.',
    auth: credentialAuth('api-token', 'posthog-personal-api-key'),
    networkScopes: ['https://app.posthog.com/api'],
    capabilities: [
      ['events.read', 'Read events', 'Query approved analytics events.', 'read'],
      ['insights.read', 'Read insights', 'Inspect saved insights and trends.', 'read'],
      ['flags.manage', 'Manage flags', 'Update feature flags only after explicit approval.', 'manage']
    ]
  },
  {
    id: 'supabase',
    name: 'Supabase',
    category: 'database',
    description: 'Inspect Supabase projects, schemas, logs, and functions through project-scoped credentials.',
    auth: credentialAuth('api-token', 'supabase-access-token'),
    networkScopes: ['https://api.supabase.com'],
    capabilities: [
      ['projects.read', 'Read projects', 'Inspect approved project metadata.', 'read'],
      ['database.read', 'Read database metadata', 'Inspect schemas without exposing stored credentials.', 'read'],
      ['functions.manage', 'Manage functions', 'Deploy functions only after explicit approval.', 'manage']
    ],
    iconFallback: 'database'
  },
  {
    id: 'firebase',
    name: 'Firebase',
    category: 'database',
    description: 'Inspect Firebase projects and run user-approved hosting or function operations.',
    auth: credentialAuth('service-account', 'google-service-account'),
    networkScopes: ['https://firebase.googleapis.com', 'https://firebasehosting.googleapis.com'],
    capabilities: [
      ['projects.read', 'Read projects', 'Inspect approved Firebase projects.', 'read'],
      ['hosting.manage', 'Manage hosting', 'Run hosting operations after explicit approval.', 'manage'],
      ['functions.manage', 'Manage functions', 'Run function operations after explicit approval.', 'manage']
    ],
    iconFallback: 'database'
  },
  {
    id: 'postgresql',
    name: 'PostgreSQL',
    category: 'database',
    description: 'Inspect schemas and run bounded, user-approved queries against a configured PostgreSQL database.',
    auth: credentialAuth('connection-string', 'postgresql-connection-string'),
    networkScopes: ['user-configured PostgreSQL endpoint only'],
    configFields: {
      endpoint: field('string', 'Database host', 'Host and port covered by the explicit network grant.', true),
      readOnly: field('boolean', 'Read-only mode', 'Prevent mutating SQL operations in the adapter.', false, { default: true })
    },
    capabilities: [
      ['schema.read', 'Read schema', 'Inspect database schema metadata.', 'read'],
      ['queries.read', 'Run read queries', 'Run bounded read-only queries.', 'read'],
      ['queries.write', 'Run write queries', 'Run user-approved mutations when read-only mode is disabled.', 'write']
    ],
    permissions: [
      { kind: 'database', access: 'read', required: true, scopes: ['configured database only'], risk: 'medium', rationale: 'Limit queries to the configured database.' }
    ],
    iconFallback: 'database'
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    category: 'database',
    description: 'Inspect collections and run bounded, user-approved operations against a configured MongoDB deployment.',
    auth: credentialAuth('connection-string', 'mongodb-connection-string'),
    networkScopes: ['user-configured MongoDB endpoint only'],
    configFields: {
      endpoint: field('string', 'Database host', 'Host covered by the explicit network grant.', true),
      readOnly: field('boolean', 'Read-only mode', 'Prevent mutating database operations in the adapter.', false, { default: true })
    },
    capabilities: [
      ['schema.read', 'Read collections', 'Inspect databases, collections, and indexes.', 'read'],
      ['queries.read', 'Run read queries', 'Run bounded read-only queries.', 'read'],
      ['queries.write', 'Run write operations', 'Run user-approved mutations when read-only mode is disabled.', 'write']
    ],
    permissions: [
      { kind: 'database', access: 'read', required: true, scopes: ['configured database only'], risk: 'medium', rationale: 'Limit operations to the configured database.' }
    ],
    iconFallback: 'database'
  },
  {
    id: 'docker',
    name: 'Docker',
    category: 'infrastructure',
    description: 'Inspect local Docker resources and perform user-approved container and image operations.',
    auth: noCredentialAuth('local-socket'),
    capabilities: [
      ['containers.read', 'Read containers', 'Inspect local container state and logs.', 'read'],
      ['containers.manage', 'Manage containers', 'Start, stop, or remove containers after approval.', 'manage'],
      ['images.manage', 'Manage images', 'Build or remove images after approval.', 'manage']
    ],
    permissions: [
      { kind: 'container', access: 'manage', required: true, scopes: ['local Docker context only'], risk: 'high', rationale: 'Docker control can mutate the host and must be explicitly granted.' },
      { kind: 'process', access: 'execute', required: true, scopes: ['docker executable only'], risk: 'high', rationale: 'Invoke only the Docker CLI through an argument-array adapter.' }
    ],
    configFields: {
      dockerContext: field('string', 'Docker context', 'Named local Docker context to inspect.', false, { default: 'default' })
    },
    iconFallback: 'terminal',
    healthProbe: 'adapter'
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes',
    category: 'infrastructure',
    description: 'Inspect a selected Kubernetes context and perform explicit, user-approved cluster operations.',
    auth: noCredentialAuth('cli'),
    capabilities: [
      ['resources.read', 'Read resources', 'Inspect resources in approved contexts and namespaces.', 'read'],
      ['resources.manage', 'Manage resources', 'Apply user-approved resource changes.', 'manage'],
      ['logs.read', 'Read logs', 'Read bounded pod logs.', 'read']
    ],
    permissions: [
      { kind: 'process', access: 'execute', required: true, scopes: ['kubectl executable only'], risk: 'high', rationale: 'Invoke only kubectl through an argument-array adapter.' },
      { kind: 'cloud', access: 'connect', required: true, scopes: ['user-selected cluster context only'], risk: 'high', rationale: 'Restrict operations to the selected cluster context.' },
      { kind: 'filesystem', access: 'read', required: false, scopes: ['user-selected kubeconfig only'], risk: 'medium', rationale: 'Read a kubeconfig only when the user selects it.' }
    ],
    configFields: {
      context: field('string', 'Cluster context', 'Exact kubectl context to use.', true),
      namespace: field('string', 'Namespace', 'Default namespace for bounded operations.', false, { default: 'default' })
    },
    iconFallback: 'terminal',
    healthProbe: 'adapter'
  },
  {
    id: 'aws',
    name: 'AWS',
    category: 'cloud',
    description: 'Inspect approved AWS accounts and run explicit service operations through scoped credentials.',
    auth: credentialAuth('api-token', 'aws-credential-set'),
    networkScopes: ['https://sts.amazonaws.com'],
    capabilities: [
      ['accounts.read', 'Read identity', 'Verify the configured AWS account and principal.', 'read'],
      ['resources.read', 'Read resources', 'Inspect resources covered by granted service scopes.', 'read'],
      ['resources.manage', 'Manage resources', 'Perform explicit approved cloud mutations.', 'manage']
    ],
    iconFallback: 'cloud'
  },
  {
    id: 'google-cloud',
    name: 'Google Cloud',
    category: 'cloud',
    description: 'Inspect approved Google Cloud projects and run explicit operations through scoped service credentials.',
    auth: credentialAuth('service-account', 'google-service-account'),
    networkScopes: ['https://cloudresourcemanager.googleapis.com', 'https://serviceusage.googleapis.com'],
    capabilities: [
      ['projects.read', 'Read projects', 'Inspect approved project metadata.', 'read'],
      ['resources.read', 'Read resources', 'Inspect resources covered by granted APIs.', 'read'],
      ['resources.manage', 'Manage resources', 'Perform explicit approved cloud mutations.', 'manage']
    ],
    iconFallback: 'cloud'
  },
  {
    id: 'microsoft-azure',
    name: 'Microsoft Azure',
    category: 'cloud',
    description: 'Inspect approved Azure subscriptions and run explicit resource operations through scoped credentials.',
    auth: credentialAuth('oauth2', 'azure-oauth-token'),
    networkScopes: ['https://management.azure.com'],
    capabilities: [
      ['subscriptions.read', 'Read subscriptions', 'Inspect approved subscriptions and tenants.', 'read'],
      ['resources.read', 'Read resources', 'Inspect resources in approved scopes.', 'read'],
      ['resources.manage', 'Manage resources', 'Perform explicit approved cloud mutations.', 'manage']
    ],
    iconFallback: 'cloud'
  },
  {
    id: 'hugging-face',
    name: 'Hugging Face',
    category: 'ai',
    description: 'Search Hub resources and access approved models, datasets, and spaces through a scoped token.',
    auth: credentialAuth('api-token', 'hugging-face-access-token'),
    networkScopes: ['https://huggingface.co/api'],
    capabilities: [
      ['models.read', 'Read models', 'Search and inspect model metadata.', 'read'],
      ['datasets.read', 'Read datasets', 'Search and inspect dataset metadata.', 'read'],
      ['repositories.manage', 'Manage Hub repositories', 'Update approved Hub repositories after confirmation.', 'manage']
    ]
  },
  {
    id: 'browser-playwright',
    name: 'Browser/Playwright',
    category: 'browser',
    description: 'Automate user-approved browser origins with isolated contexts, bounded downloads, and visible health.',
    auth: noCredentialAuth(),
    capabilities: [
      ['pages.read', 'Read pages', 'Inspect user-approved page content and accessibility state.', 'read'],
      ['pages.execute', 'Automate pages', 'Click, type, and navigate only within approved origins.', 'execute'],
      ['screenshots.write', 'Capture screenshots', 'Write screenshots to an approved output location.', 'write']
    ],
    permissions: [
      { kind: 'browser', access: 'manage', required: true, scopes: ['isolated browser context only'], risk: 'high', rationale: 'Browser automation acts only in a dedicated, user-approved context.' },
      { kind: 'network', access: 'connect', required: true, scopes: ['user-selected origins only'], risk: 'medium', rationale: 'Navigation is restricted to explicit user-selected origins.' },
      { kind: 'filesystem', access: 'write', required: false, scopes: ['user-selected output folder only'], risk: 'medium', rationale: 'Downloads and screenshots require an explicit output folder.' }
    ],
    configFields: {
      browserChannel: field('enum', 'Browser channel', 'Installed browser channel selected for automation.', false, { default: 'chromium', choices: ['chromium', 'chrome', 'edge'] }),
      headless: field('boolean', 'Headless', 'Run without a visible browser window.', false, { default: false })
    },
    iconFallback: 'browser',
    healthProbe: 'local'
  },
  {
    id: 'local-files-terminal',
    name: 'Local Files & Terminal',
    category: 'local-tools',
    description: 'Read and modify user-selected workspaces and run explicitly approved commands through Akorith safety paths.',
    auth: noCredentialAuth(),
    capabilities: [
      ['files.read', 'Read files', 'Read files inside user-selected workspace roots.', 'read'],
      ['files.write', 'Write files', 'Write files through validated workspace operations.', 'write'],
      ['terminal.execute', 'Run commands', 'Run explicit commands through the existing approved execution path.', 'execute']
    ],
    permissions: [
      { kind: 'filesystem', access: 'read', required: true, scopes: ['user-selected workspace roots only'], risk: 'medium', rationale: 'File reads stay inside selected workspace roots.' },
      { kind: 'filesystem', access: 'write', required: true, scopes: ['user-selected workspace roots only'], risk: 'high', rationale: 'File writes require explicit workspace grants and path validation.' },
      { kind: 'process', access: 'execute', required: true, scopes: ['user-approved commands only'], risk: 'high', rationale: 'Commands use Akorith execution safety and never bypass the single PTY write path.' }
    ],
    configFields: {
      workspaceRoot: field('path', 'Workspace root', 'Absolute user-selected workspace root.', true),
      shell: field('enum', 'Shell', 'Fixed shell kind selected by the user.', false, { default: 'system', choices: ['system', 'powershell', 'zsh', 'bash'] })
    },
    iconFallback: 'terminal',
    healthProbe: 'local'
  }
]

export const REQUIRED_PLUGIN_NAMES = Object.freeze([
  'GitHub',
  'GitLab',
  'Bitbucket',
  'Linear',
  'Jira',
  'Notion',
  'Slack',
  'Discord',
  'Gmail',
  'Google Calendar',
  'Google Drive',
  'Figma',
  'Vercel',
  'Netlify',
  'Cloudflare',
  'Sentry',
  'Datadog',
  'PostHog',
  'Supabase',
  'Firebase',
  'PostgreSQL',
  'MongoDB',
  'Docker',
  'Kubernetes',
  'AWS',
  'Google Cloud',
  'Microsoft Azure',
  'Hugging Face',
  'Browser/Playwright',
  'Local Files & Terminal'
] as const)

export const MARKETPLACE_PLUGINS: readonly PluginManifest[] = Object.freeze(seeds.map(buildManifest))

export function getMarketplacePlugin(id: string): PluginManifest | undefined {
  return MARKETPLACE_PLUGINS.find((plugin) => plugin.id === id)
}
