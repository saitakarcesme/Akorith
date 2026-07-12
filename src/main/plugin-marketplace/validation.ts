import {
  PLUGIN_AUTH_MODES,
  PLUGIN_CATEGORIES,
  type PluginCapabilityAccess,
  type PluginConfigFieldType,
  type PluginManifest,
  type PluginPermissionKind,
  type PluginPermissionRisk
} from './types'

export interface ManifestValidationIssue {
  path: string
  message: string
}

export type ManifestValidationResult =
  | { ok: true; manifest: PluginManifest; issues: [] }
  | { ok: false; issues: ManifestValidationIssue[] }

const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const CONFIG_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const CATEGORIES = new Set<string>(PLUGIN_CATEGORIES)
const AUTH_MODES = new Set<string>(PLUGIN_AUTH_MODES)
const CAPABILITY_ACCESS = new Set<PluginCapabilityAccess>(['read', 'write', 'execute', 'observe', 'manage'])
const PERMISSION_KINDS = new Set<PluginPermissionKind>([
  'network',
  'credentials',
  'filesystem',
  'process',
  'browser',
  'database',
  'container',
  'cloud'
])
const PERMISSION_ACCESS = new Set(['read', 'write', 'execute', 'connect', 'manage'])
const PERMISSION_RISKS = new Set<PluginPermissionRisk>(['low', 'medium', 'high'])
const CONFIG_TYPES = new Set<PluginConfigFieldType>([
  'string',
  'number',
  'boolean',
  'enum',
  'url',
  'path',
  'credential-reference'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function add(issues: ManifestValidationIssue[], path: string, message: string): void {
  issues.push({ path, message })
}

function isHttpUrl(value: unknown): boolean {
  if (!nonEmptyString(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function requireString(record: Record<string, unknown>, key: string, path: string, issues: ManifestValidationIssue[]): string {
  const value = record[key]
  if (!nonEmptyString(value)) {
    add(issues, `${path}.${key}`, 'must be a non-empty string')
    return ''
  }
  return value
}

function requireArray(record: Record<string, unknown>, key: string, path: string, issues: ManifestValidationIssue[]): unknown[] {
  const value = record[key]
  if (!Array.isArray(value)) {
    add(issues, `${path}.${key}`, 'must be an array')
    return []
  }
  return value
}

function validateContributionIds(
  values: unknown[],
  key: string,
  pluginId: string,
  issues: ManifestValidationIssue[]
): Set<string> {
  const ids = new Set<string>()
  if (values.length === 0) add(issues, key, 'must contain at least one contribution')
  values.forEach((value, index) => {
    const path = `${key}[${index}]`
    if (!isRecord(value)) {
      add(issues, path, 'must be an object')
      return
    }
    const id = requireString(value, 'id', path, issues)
    if (id && !id.startsWith(`${pluginId}.`)) add(issues, `${path}.id`, `must start with "${pluginId}."`)
    if (ids.has(id)) add(issues, `${path}.id`, 'must be unique')
    ids.add(id)
  })
  return ids
}

function validateConfigSchema(value: unknown, authRequired: boolean, issues: ManifestValidationIssue[]): void {
  const path = 'manifest.configSchema'
  if (!isRecord(value)) {
    add(issues, path, 'must be an object')
    return
  }
  if (value.version !== 1) add(issues, `${path}.version`, 'must equal 1')
  if (value.additionalProperties !== false) add(issues, `${path}.additionalProperties`, 'must be false')
  if (!isRecord(value.fields)) {
    add(issues, `${path}.fields`, 'must be an object')
    return
  }

  let credentialReferences = 0
  for (const [name, rawField] of Object.entries(value.fields)) {
    const fieldPath = `${path}.fields.${name}`
    if (!CONFIG_KEY_PATTERN.test(name)) add(issues, fieldPath, 'field name must be a stable identifier')
    if (!isRecord(rawField)) {
      add(issues, fieldPath, 'must be an object')
      continue
    }
    const type = rawField.type
    if (!nonEmptyString(type) || !CONFIG_TYPES.has(type as PluginConfigFieldType)) {
      add(issues, `${fieldPath}.type`, 'is not a supported field type')
    }
    requireString(rawField, 'title', fieldPath, issues)
    requireString(rawField, 'description', fieldPath, issues)
    if (typeof rawField.required !== 'boolean') add(issues, `${fieldPath}.required`, 'must be boolean')
    if (/token|password|secret|credential|api.?key|access.?key|private.?key/i.test(name) && type !== 'credential-reference') {
      add(issues, `${fieldPath}.type`, 'secret-like fields must be credential references, never plaintext config')
    }
    if (type === 'credential-reference') {
      credentialReferences++
      if ('default' in rawField) add(issues, `${fieldPath}.default`, 'credential references cannot have defaults')
    }
    if (type === 'enum' && (!Array.isArray(rawField.choices) || rawField.choices.length === 0)) {
      add(issues, `${fieldPath}.choices`, 'enum fields require choices')
    }
    if (Array.isArray(rawField.choices) && rawField.choices.some((choice) => !nonEmptyString(choice))) {
      add(issues, `${fieldPath}.choices`, 'choices must be non-empty strings')
    }
    if ('default' in rawField) {
      const defaultValue = rawField.default
      const defaultMatches =
        ((type === 'string' || type === 'url' || type === 'path' || type === 'enum') && typeof defaultValue === 'string') ||
        (type === 'number' && typeof defaultValue === 'number' && Number.isFinite(defaultValue)) ||
        (type === 'boolean' && typeof defaultValue === 'boolean')
      if (!defaultMatches) add(issues, `${fieldPath}.default`, 'does not match the field type')
      if (type === 'enum' && Array.isArray(rawField.choices) && !rawField.choices.includes(defaultValue)) {
        add(issues, `${fieldPath}.default`, 'must be one of the enum choices')
      }
    }
    if ('min' in rawField && (typeof rawField.min !== 'number' || !Number.isFinite(rawField.min))) {
      add(issues, `${fieldPath}.min`, 'must be a finite number')
    }
    if ('max' in rawField && (typeof rawField.max !== 'number' || !Number.isFinite(rawField.max))) {
      add(issues, `${fieldPath}.max`, 'must be a finite number')
    }
    if (typeof rawField.min === 'number' && typeof rawField.max === 'number' && rawField.min > rawField.max) {
      add(issues, fieldPath, 'min cannot exceed max')
    }
  }

  if (authRequired && credentialReferences === 0) {
    add(issues, `${path}.fields`, 'credential-backed plugins require a credential-reference field')
  }
}

export function validatePluginManifest(input: unknown): ManifestValidationResult {
  const issues: ManifestValidationIssue[] = []
  if (!isRecord(input)) return { ok: false, issues: [{ path: 'manifest', message: 'must be an object' }] }

  if (input.schemaVersion !== 1) add(issues, 'manifest.schemaVersion', 'must equal 1')
  const id = requireString(input, 'id', 'manifest', issues)
  if (id && !ID_PATTERN.test(id)) add(issues, 'manifest.id', 'must use lowercase letters, digits, dots, or hyphens')
  requireString(input, 'name', 'manifest', issues)
  const version = requireString(input, 'version', 'manifest', issues)
  if (version && !SEMVER_PATTERN.test(version)) add(issues, 'manifest.version', 'must be semantic version x.y.z')
  const category = requireString(input, 'category', 'manifest', issues)
  if (category && !CATEGORIES.has(category)) add(issues, 'manifest.category', 'is not a supported category')
  const description = requireString(input, 'description', 'manifest', issues)
  if (description && description.length < 24) add(issues, 'manifest.description', 'must explain the plugin in at least 24 characters')

  if (!isRecord(input.publisher)) {
    add(issues, 'manifest.publisher', 'must be an object')
  } else {
    requireString(input.publisher, 'id', 'manifest.publisher', issues)
    requireString(input.publisher, 'name', 'manifest.publisher', issues)
    if ('url' in input.publisher && !isHttpUrl(input.publisher.url)) add(issues, 'manifest.publisher.url', 'must be an HTTP(S) URL')
  }

  if (!isRecord(input.icon)) {
    add(issues, 'manifest.icon', 'must be an object')
  } else {
    if (input.icon.kind !== 'brand' && input.icon.kind !== 'symbol') add(issues, 'manifest.icon.kind', 'must be brand or symbol')
    requireString(input.icon, 'value', 'manifest.icon', issues)
    if (!['plug', 'database', 'cloud', 'terminal', 'browser'].includes(String(input.icon.fallback))) {
      add(issues, 'manifest.icon.fallback', 'must name a built-in fallback icon')
    }
  }

  let authRequired = false
  if (!isRecord(input.auth)) {
    add(issues, 'manifest.auth', 'must be an object')
  } else {
    const mode = requireString(input.auth, 'mode', 'manifest.auth', issues)
    if (mode && !AUTH_MODES.has(mode)) add(issues, 'manifest.auth.mode', 'is not supported')
    if (typeof input.auth.required !== 'boolean') add(issues, 'manifest.auth.required', 'must be boolean')
    authRequired = input.auth.required === true
    const credentialKinds = requireArray(input.auth, 'credentialKinds', 'manifest.auth', issues)
    if (credentialKinds.some((kind) => !nonEmptyString(kind))) add(issues, 'manifest.auth.credentialKinds', 'must contain non-empty strings')
    if (authRequired && (mode === 'none' || mode === 'cli' || mode === 'local-socket')) {
      add(issues, 'manifest.auth', 'a required credential cannot use a credential-free auth mode')
    }
    if (!authRequired && ['oauth2', 'api-token', 'service-account', 'connection-string'].includes(mode)) {
      add(issues, 'manifest.auth', 'credential-backed auth modes must require protected credentials')
    }
    if (authRequired && credentialKinds.length === 0) add(issues, 'manifest.auth.credentialKinds', 'must declare at least one secret kind')
    if (!authRequired && credentialKinds.length > 0) add(issues, 'manifest.auth.credentialKinds', 'must be empty when auth is not required')
    if ('helpUrl' in input.auth && !isHttpUrl(input.auth.helpUrl)) add(issues, 'manifest.auth.helpUrl', 'must be an HTTP(S) URL')
  }

  const capabilities = requireArray(input, 'capabilities', 'manifest', issues)
  const capabilityIds = validateContributionIds(capabilities, 'manifest.capabilities', id, issues)
  capabilities.forEach((raw, index) => {
    if (!isRecord(raw)) return
    const path = `manifest.capabilities[${index}]`
    requireString(raw, 'title', path, issues)
    requireString(raw, 'description', path, issues)
    if (!CAPABILITY_ACCESS.has(raw.access as PluginCapabilityAccess)) add(issues, `${path}.access`, 'is not supported')
  })

  const permissions = requireArray(input, 'permissions', 'manifest', issues)
  const permissionIds = validateContributionIds(permissions, 'manifest.permissions', id, issues)
  permissions.forEach((raw, index) => {
    if (!isRecord(raw)) return
    const path = `manifest.permissions[${index}]`
    if (!PERMISSION_KINDS.has(raw.kind as PluginPermissionKind)) add(issues, `${path}.kind`, 'is not supported')
    if (!PERMISSION_ACCESS.has(String(raw.access))) add(issues, `${path}.access`, 'is not supported')
    if (!PERMISSION_RISKS.has(raw.risk as PluginPermissionRisk)) add(issues, `${path}.risk`, 'is not supported')
    if (typeof raw.required !== 'boolean') add(issues, `${path}.required`, 'must be boolean')
    requireString(raw, 'rationale', path, issues)
    const scopes = requireArray(raw, 'scopes', path, issues)
    if (scopes.length === 0 || scopes.some((scope) => !nonEmptyString(scope))) add(issues, `${path}.scopes`, 'must contain explicit scopes')
    if (scopes.some((scope) => typeof scope === 'string' && (scope.trim() === '*' || scope.includes('://*.') || scope.endsWith(':*')))) {
      add(issues, `${path}.scopes`, 'unrestricted wildcard scopes are not allowed')
    }
  })

  const skills = requireArray(input, 'skills', 'manifest', issues)
  validateContributionIds(skills, 'manifest.skills', id, issues)
  skills.forEach((raw, index) => {
    if (!isRecord(raw)) return
    const path = `manifest.skills[${index}]`
    requireString(raw, 'label', path, issues)
    requireString(raw, 'description', path, issues)
  })
  const mcpServers = requireArray(input, 'mcpServers', 'manifest', issues)
  validateContributionIds(mcpServers, 'manifest.mcpServers', id, issues)
  mcpServers.forEach((raw, index) => {
    if (!isRecord(raw)) return
    const path = `manifest.mcpServers[${index}]`
    requireString(raw, 'label', path, issues)
    if (raw.transport !== 'adapter') add(issues, `${path}.transport`, 'must use the typed adapter transport')
    if (raw.availability !== 'requires-connection' && raw.availability !== 'local-probe') {
      add(issues, `${path}.availability`, 'is not supported')
    }
  })
  const hooks = requireArray(input, 'hooks', 'manifest', issues)
  validateContributionIds(hooks, 'manifest.hooks', id, issues)
  hooks.forEach((raw, index) => {
    if (!isRecord(raw)) return
    const path = `manifest.hooks[${index}]`
    if (!['before-command', 'after-command', 'connection-changed', 'health-changed'].includes(String(raw.event))) {
      add(issues, `${path}.event`, 'is not supported')
    }
    requireString(raw, 'description', path, issues)
  })
  const apps = requireArray(input, 'apps', 'manifest', issues)
  validateContributionIds(apps, 'manifest.apps', id, issues)
  apps.forEach((raw, index) => {
    if (!isRecord(raw)) return
    const path = `manifest.apps[${index}]`
    requireString(raw, 'label', path, issues)
    requireString(raw, 'description', path, issues)
    if (!['panel', 'resource-picker', 'settings'].includes(String(raw.surface))) add(issues, `${path}.surface`, 'is not supported')
  })
  const commands = requireArray(input, 'commands', 'manifest', issues)
  validateContributionIds(commands, 'manifest.commands', id, issues)
  commands.forEach((raw, index) => {
    if (!isRecord(raw)) return
    const path = `manifest.commands[${index}]`
    requireString(raw, 'title', path, issues)
    requireString(raw, 'description', path, issues)
  })

  const withCapabilityRefs = [...skills, ...mcpServers, ...apps, ...commands]
  withCapabilityRefs.forEach((raw, index) => {
    if (!isRecord(raw) || !Array.isArray(raw.capabilityIds)) {
      add(issues, `manifest.contributions[${index}].capabilityIds`, 'must be an array')
      return
    }
    if (raw.capabilityIds.length === 0) add(issues, `manifest.contributions[${index}].capabilityIds`, 'must not be empty')
    for (const reference of raw.capabilityIds) {
      if (!nonEmptyString(reference) || !capabilityIds.has(reference)) {
        add(issues, `manifest.contributions[${index}].capabilityIds`, `references unknown capability "${String(reference)}"`)
      }
    }
  })
  commands.forEach((raw, index) => {
    if (!isRecord(raw) || !Array.isArray(raw.permissionIds)) {
      add(issues, `manifest.commands[${index}].permissionIds`, 'must be an array')
      return
    }
    for (const reference of raw.permissionIds) {
      if (!nonEmptyString(reference) || !permissionIds.has(reference)) {
        add(issues, `manifest.commands[${index}].permissionIds`, `references unknown permission "${String(reference)}"`)
      }
    }
    if (typeof raw.requiresConnection !== 'boolean') add(issues, `manifest.commands[${index}].requiresConnection`, 'must be boolean')
  })

  validateConfigSchema(input.configSchema, authRequired, issues)

  if (!isRecord(input.health)) {
    add(issues, 'manifest.health', 'must be an object')
  } else {
    if (input.health.probe !== 'adapter' && input.health.probe !== 'local') add(issues, 'manifest.health.probe', 'must be adapter or local')
    if (input.health.initialState !== 'disconnected') add(issues, 'manifest.health.initialState', 'must be disconnected')
    if (!Number.isInteger(input.health.timeoutMs) || Number(input.health.timeoutMs) < 100 || Number(input.health.timeoutMs) > 120_000) {
      add(issues, 'manifest.health.timeoutMs', 'must be an integer between 100 and 120000')
    }
    if (!Number.isInteger(input.health.staleAfterMs) || Number(input.health.staleAfterMs) < Number(input.health.timeoutMs)) {
      add(issues, 'manifest.health.staleAfterMs', 'must be an integer at least as large as timeoutMs')
    }
    if (authRequired && input.health.probe !== 'adapter') add(issues, 'manifest.health.probe', 'credential-backed plugins require an adapter probe')
  }

  return issues.length === 0
    ? { ok: true, manifest: input as unknown as PluginManifest, issues: [] }
    : { ok: false, issues }
}

export function assertValidPluginManifest(input: unknown): asserts input is PluginManifest {
  const result = validatePluginManifest(input)
  if (!result.ok) {
    const detail = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
    throw new Error(`Invalid plugin manifest: ${detail}`)
  }
}
