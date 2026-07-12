# Akorith desktop updates

Installed Akorith builds update from verified GitHub Release artifacts through
`electron-updater`. Updating an installed app never performs `git pull`, never needs a
source checkout, and never embeds a GitHub token in the client.

The complete operator procedure, required repository secrets, artifact inventory,
signature checks, rollback policy, and stable/beta channel rules are documented in
[Production updates and releases](production-updates-releases.md).

## User flow

Open **Settings -> Updates**. The page shows the current version and channel, last check,
release notes, download progress, and any sanitized error. The explicit flow is:

1. **Check now** queries the configured public GitHub Release feed.
2. **Download** fetches a newer artifact only after the user requests it.
3. **Restart and install** consumes a short-lived, one-use authorization tied to that
   downloaded version.

Automatic checks can be enabled, but Akorith never downloads automatically, never
installs on quit, and never downgrades. Development/source runs do not contact the
packaged feed. Windows portable builds identify themselves as portable and require the
user to replace the executable manually.

## Release safety

The release workflow verifies the exact tag, package and lockfile version, and ancestry
from `origin/main`; runs the full test and audit gates; builds on native Windows and
macOS runners; verifies Authenticode or Developer ID/Gatekeeper/notarization; launches
the packaged app; and validates updater metadata and hashes before a draft release is
made public. Missing signing credentials stop publication.

Source checkouts are developer workspaces, not installed-app update targets. Keep them
current with normal reviewed Git operations outside the packaged update UI.
