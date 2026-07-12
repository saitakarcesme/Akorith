# Plugin development and permission model

Akorith's Plugins surface is a marketplace for 30 audited, in-tree manifests. Installing a current catalog item activates a bundled, versioned integration contract; it does not download or execute an arbitrary npm package. Network or host behavior must be supplied by a trusted main-process adapter that implements the typed runtime contract.

## Catalog and implementation status

Every item below has a schema-1 manifest, semantic version, publisher/icon fallback, category/description, capabilities, skill contribution, adapter-only MCP contribution, health hook, app surface, command, explicit permissions, closed config schema, authentication contract, disconnected initial health, lifecycle persistence, and manifest/contract tests.

`Lifecycle ready` means Install/Enable/Disable/Update/Uninstall and restart recovery are implemented for the bundled item. `Adapter required` means Akorith correctly keeps it disconnected until a real authenticated/local adapter probe runs; the current marketplace service does not claim the external service operation succeeded.

| # | ID | Display name | Authentication | Runtime status |
| ---: | --- | --- | --- | --- |
| 1 | `github` | GitHub | OAuth token reference | Lifecycle ready; adapter required |
| 2 | `gitlab` | GitLab | OAuth token reference | Lifecycle ready; adapter required |
| 3 | `bitbucket` | Bitbucket | OAuth token reference | Lifecycle ready; adapter required |
| 4 | `linear` | Linear | OAuth token reference | Lifecycle ready; adapter required |
| 5 | `jira` | Jira | API token reference + selected site/account | Lifecycle ready; adapter required |
| 6 | `notion` | Notion | Integration-token reference | Lifecycle ready; adapter required |
| 7 | `slack` | Slack | OAuth token reference | Lifecycle ready; adapter required |
| 8 | `discord` | Discord | Bot-token reference | Lifecycle ready; adapter required |
| 9 | `gmail` | Gmail | Google OAuth token reference | Lifecycle ready; adapter required |
| 10 | `google-calendar` | Google Calendar | Google OAuth token reference | Lifecycle ready; adapter required |
| 11 | `google-drive` | Google Drive | Google OAuth token reference | Lifecycle ready; adapter required |
| 12 | `figma` | Figma | OAuth token reference | Lifecycle ready; adapter required |
| 13 | `vercel` | Vercel | Access-token reference | Lifecycle ready; adapter required |
| 14 | `netlify` | Netlify | OAuth token reference | Lifecycle ready; adapter required |
| 15 | `cloudflare` | Cloudflare | API-token reference | Lifecycle ready; adapter required |
| 16 | `sentry` | Sentry | Auth-token reference | Lifecycle ready; adapter required |
| 17 | `datadog` | Datadog | API/application-key reference | Lifecycle ready; adapter required |
| 18 | `posthog` | PostHog | Personal API-key reference | Lifecycle ready; adapter required |
| 19 | `supabase` | Supabase | Access-token reference | Lifecycle ready; adapter required |
| 20 | `firebase` | Firebase | Service-account reference | Lifecycle ready; adapter required |
| 21 | `postgresql` | PostgreSQL | Connection-string reference | Lifecycle ready; database adapter required |
| 22 | `mongodb` | MongoDB | Connection-string reference | Lifecycle ready; database adapter required |
| 23 | `docker` | Docker | Local socket/context, no stored credential | Lifecycle ready; local adapter required |
| 24 | `kubernetes` | Kubernetes | Existing CLI/context, optional selected kubeconfig | Lifecycle ready; CLI adapter required |
| 25 | `aws` | AWS | Credential-set reference | Lifecycle ready; adapter required |
| 26 | `google-cloud` | Google Cloud | Service-account reference | Lifecycle ready; adapter required |
| 27 | `microsoft-azure` | Microsoft Azure | OAuth token reference | Lifecycle ready; adapter required |
| 28 | `hugging-face` | Hugging Face | Access-token reference | Lifecycle ready; adapter required |
| 29 | `browser-playwright` | Browser/Playwright | None; selected origins/context | Lifecycle ready; local browser adapter required |
| 30 | `local-files-terminal` | Local Files & Terminal | None; selected workspace/command grants | Lifecycle ready; local safety adapter required |

The GitHub repository-creation contract used by Loop is intentionally unavailable until the GitHub item has a live authenticated adapter. A bundled manifest or an enabled lifecycle state alone is not authentication.

## Manifest contract

A manifest must validate before it can enter the catalog. Required rules include:

- schema version 1, lowercase stable ID, semantic version, supported category, useful description, publisher, and built-in icon fallback;
- at least one capability plus non-empty skills, MCP, hooks, apps, and commands;
- every contribution ID begins with `<plugin-id>.` and every capability/permission reference resolves;
- MCP transport is exactly `adapter`; a manifest cannot name an arbitrary executable;
- configuration sets `additionalProperties: false` and uses only string, number, boolean, enum, URL, path, or credential-reference fields;
- a secret-like config key must use `credential-reference`, never a plaintext string/default;
- credential-backed auth must declare a protected credential kind and an adapter health probe;
- every permission names kind, access, required flag, risk, rationale, and at least one concrete scope;
- `*`, wildcard subdomains, and suffix wildcard scopes are rejected;
- health starts `disconnected`, timeout is 100-120,000 ms, and staleness is no shorter than timeout.

The supported permission kinds are network, credentials, filesystem, process, browser, database, container, and cloud. Access is read, write, execute, connect, or manage; risk is low, medium, or high.

## Permission semantics

Installing only records that the audited bundled version is present. Enabling is the grant transition: all required manifest permissions and their exact scopes must be accepted; the lifecycle reducer rejects a missing required grant. Disabling prevents a connection. Uninstalling clears installation and health state.

Examples of bounded scopes in the catalog:

- GitHub network calls: `https://api.github.com` and a vault reference owned by `github`;
- PostgreSQL/MongoDB: only the configured endpoint/database, with read-only enabled by default;
- Docker: local Docker context and only an argument-array Docker adapter;
- Kubernetes: one selected context/namespace and only an argument-array kubectl adapter;
- Browser/Playwright: isolated browser context and user-selected origins, with an optional selected output folder;
- Local Files & Terminal: selected workspace roots and user-approved commands through Akorith's validated execution/bridge paths.

Enablement is not connection proof. A plugin becomes `connected` only if it is installed and enabled, required credentials exist, a matching adapter health report is verified and fresh, and authentication was verified for credential-backed plugins. Missing credentials, missing probe, stale probe, or unverified/auth-failed probe remains `disconnected`. A verified degraded report becomes `degraded`; an unhealthy report becomes `error`.

The current generic marketplace Check/Connect action records an explicit disconnected report when no runtime adapter is connected. It never converts manifest data into a healthy status.

## Credential handling

Production adapters must use `SafeStorageCredentialVault`. It stores only non-secret metadata plus OS-encrypted ciphertext. If Electron `safeStorage` encryption is unavailable, credential storage and use fail closed.

Plaintext is available only inside a trusted main-process callback with:

- the credential ID;
- the exact owning plugin ID;
- a non-empty auditable purpose.

Cross-plugin use is rejected. Callback copies are zeroed in `finally`. Renderer APIs and plugin config receive only opaque credential references and metadata, never decrypted values. Tests use an in-memory vault with the same no-getter, scoped-callback contract.

## Implementing a trusted runtime adapter

1. Add or revise an in-tree manifest seed and bump its version. Do not modify an already published semantic version without a catalog/release version change.
2. Keep capability IDs and permission scopes as narrow as the actual provider API permits.
3. Implement `PluginRuntimeAdapter` in the trusted main-process integration layer:
   - `pluginId` exactly matches the manifest;
   - `probe(context)` returns a verified health report only after a real check;
   - `invoke(request, context)` returns bounded, structured, secret-free output;
   - `disconnect(context)` releases listeners/sessions.
4. Obtain configuration, accepted permission grants, scoped credential access, AbortSignal, and audit callback only from `PluginAdapterContext`.
5. Validate command ID/input and re-check its capability/permission references before side effects.
6. For processes, use fixed executable plus argument arrays; never concatenate user input into a shell command.
7. For network requests, compare the final endpoint to granted hosts, apply time/output bounds, propagate cancellation, and redact provider payloads.
8. Emit audit events for probe, command start/completion/failure, and disconnect without credential or content leakage.
9. Register the adapter through the application-owned runtime registry. Manifests themselves never `require()` arbitrary entry points.
10. Add manifest validation, lifecycle, credential ownership, connection-health, adapter contract, error, cancellation, and restart-recovery tests.

## Lifecycle recovery

State is atomically written with mode 0600 to `plugin-marketplace.json` beneath user data. A pending lifecycle operation found on restart becomes `error` with its prior stable recovery state retained. The next valid action recovers that state before beginning. An update preserves whether the plugin was enabled; uninstall returns it to not-installed and clears health.

Marketplace telemetry records plugin invocation ID, outcome, duration, and task correlation. It does not store credentials, request bodies, response bodies, or plugin content.
