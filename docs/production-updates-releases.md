# Packaged updates and release procedure

Akorith 1.0.0 uses electron-builder for target-native artifacts and `electron-updater` for installed Windows/macOS updates from the public GitHub Releases feed configured in `package.json`. Source-checkout Git updating is not the installed-app update mechanism.

## Supported artifacts

| Platform | Targets | Updater metadata |
| --- | --- | --- |
| Windows x64 | NSIS `Akorith-Setup-<version>-x64.exe`; portable `Akorith-<version>-portable-x64.exe` | `latest.yml`, blockmaps; NSIS is the installable updater target |
| macOS arm64 | `Akorith-<version>-mac-arm64.dmg`; matching ZIP | `latest-mac.yml`, blockmaps; ZIP supplies update payload/metadata |
| Linux | AppImage configuration | In-app packaged updater is intentionally unsupported |

App ID is `com.akorith.app`, packaged product/executable name is Akorith, macOS hardened runtime is enabled with `build/entitlements.mac.plist`, and Windows executable resource editing is enabled. The standalone `dist-node/akorith-node.cjs` is included in packaged resources.

## User update policy

Settings -> Update exposes stable/beta channel selection, automatic checks, Check, Download, and explicit Install.

The updater is supported only when all of these are true: the app is packaged, it is an installed (non-portable) build, platform is Windows or macOS, app version is valid semantic version, `electron-updater` loaded, and a publish feed is configured. Development/source runs report `DEVELOPMENT_BUILD`; Windows portable builds report `PORTABLE_BUILD` with manual-upgrade guidance. Neither contacts an update feed.

Safety policy is fixed:

- `autoDownload=false`;
- `autoInstallOnAppQuit=false`;
- automatic checks, when enabled, begin 12 seconds after startup but do not download;
- stable rejects prereleases; beta accepts stable and prerelease semantic versions;
- changing channels always resets `allowDowngrade=false`; recovery uses a newer fixed release rather than an automatic downgrade;
- release names/notes/errors/progress are validated, bounded, and credential-like text is redacted;
- download is allowed only after a newer accepted release is available;
- install requires the user action that creates a random, one-use authorization for the exact downloaded version;
- authorization normally expires after two minutes and is compared in constant time;
- only a fresh valid authorization calls `quitAndInstall(false, true)`.

There is no background install on app exit.

## Repository secrets

Create these GitHub Actions repository secrets before a production release:

| Secret | Used by | Content |
| --- | --- | --- |
| `WINDOWS_CSC_LINK` | Windows job | Base64 certificate, secure URL, or electron-builder-supported Authenticode certificate reference |
| `WINDOWS_CSC_KEY_PASSWORD` | Windows job | Password for the Windows signing identity |
| `MAC_CSC_LINK` | macOS job | Developer ID Application certificate reference accepted by electron-builder |
| `MAC_CSC_KEY_PASSWORD` | macOS job | Password for the macOS signing identity |
| `APPLE_ID` | macOS notarization | Apple developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS notarization | App-specific password, not the account password |
| `APPLE_TEAM_ID` | macOS notarization | Apple Developer team identifier |

`GITHUB_TOKEN` is supplied automatically by Actions and receives `contents: write` from the release workflow; do not create or commit a personal token for publication.

The readiness library also understands Apple's API-key notarization triplet (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`), but the committed release workflow currently passes the Apple-ID triplet. Change the workflow deliberately if adopting the API-key flow.

Never place a secret in `package.json`, build configuration, `.env` committed to Git, release notes, artifacts, or workflow command output. Presence of secret environment variables is only a credential signal; readiness is not `ready` until the built signature/notarization has been independently verified.

## Prepare a release

1. Use a clean `main` and choose a semantic version. A prerelease version such as `1.1.0-beta.1` selects the prerelease publication type.
2. Update `package.json`/lockfile consistently and commit the version change.
3. Run the local gates:

   ```powershell
   npm ci
   npm run release:check
   npm run verify
   npm audit --omit=dev
   npm run build
   ```

4. On the target OS, optionally create a local smoke package:

   ```powershell
   npm run dist:win
   ```

   ```bash
   npm run dist:mac
   ```

5. Launch the packaged artifact, not `npm run dev`. Verify Akorith name/icon, Workspace/Chat, Dashboard, Loop/Benchmark/Plugins routes, Settings -> Update state, SQLite/PTY loading, and clean quit.
6. Verify source and tags are pushed, then create and push the exact version tag:

   ```bash
   git tag -a v1.0.0 -m "Akorith 1.0.0"
   git push origin v1.0.0
   ```

The workflow accepts only exact `vMAJOR.MINOR.PATCH` stable tags or `vMAJOR.MINOR.PATCH-beta.NUMBER` beta tags. `workflow_dispatch` requires one of those existing tags; it applies the same package-version and `origin/main` ancestry gates as a tag push.

## GitHub Actions release workflow

`.github/workflows/release.yml` is intentionally fail-closed and has five jobs:

1. **identity** checks out the exact existing tag, accepts only `vMAJOR.MINOR.PATCH` or `vMAJOR.MINOR.PATCH-beta.NUMBER`, requires exact `package.json`/lockfile versions, and proves the tagged commit is contained in `origin/main`;
2. **validate** on Windows runs the full verifier suite and production dependency audit;
3. **package-windows** requires both Authenticode secrets, builds NSIS plus portable with `--publish never`, verifies the installer/portable/unpacked signatures, launches the packaged app, parses stable/beta YAML, and emits a SHA-512 inventory;
4. **package-macos** requires Developer ID and Apple notarization secrets, builds DMG plus ZIP with `--publish never`, verifies `codesign`, Gatekeeper, and the stapled ticket, launches the packaged app, parses channel YAML, and emits a SHA-512 inventory;
5. **publish** starts only after both platform jobs pass, rechecks the transported manifests, creates a private draft release, uploads the exact ten-file inventory, verifies GitHub's asset list/channel state, and only then finalizes it. A failed upload deletes the draft; existing releases are never overwritten.

Packaging jobs have read-only repository permission and never receive a GitHub publication token. Only the final job has `contents: write`. Stable releases require an exact stable version; beta releases require the explicit `-beta.NUMBER` form. Manual dispatch also requires an existing validated tag and cannot turn an arbitrary branch commit into a release.

Because the committed macOS config sets `notarize: true`, production release jobs are credential-requiring. Missing Windows signing, Developer ID, or Apple notarization secrets stop their native job before packaging. A local unsigned development package is possible only with an explicit local configuration override; it is not proof of release readiness and cannot enter the release publication job.

## Post-build verification

### Windows

In PowerShell on the built installer and installed executable:

```powershell
Get-AuthenticodeSignature .\dist\Akorith-Setup-1.0.0-x64.exe | Format-List Status,StatusMessage,SignerCertificate
Get-AuthenticodeSignature "$env:LOCALAPPDATA\Programs\Akorith\Akorith.exe" | Format-List Status,StatusMessage,SignerCertificate
```

Require `Status: Valid`, install via NSIS, verify Start/Desktop shortcuts identify Akorith, launch, check for an update, download, explicitly install, and confirm the expected newer version after restart. The portable executable is not the NSIS update target.

### macOS

On the produced app/DMG:

```bash
codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/Akorith.app"
spctl --assess --type execute --verbose=4 "dist/mac-arm64/Akorith.app"
stapler validate "dist/mac-arm64/Akorith.app"
```

Require successful signature verification, Gatekeeper acceptance, and a valid stapled notarization ticket. Install the DMG build, verify Akorith identity, then exercise Check -> Download -> Install from a previous signed version. macOS updater compatibility requires the published ZIP and `latest-mac.yml`, not only a DMG.

## Channel procedure

- **Stable**: tag a version without prerelease identifiers, for example `v1.1.0`. The app uses electron-updater channel `latest` and rejects prerelease metadata.
- **Beta**: tag a semantic prerelease, for example `v1.2.0-beta.1`. The workflow publishes it as a GitHub prerelease and electron-builder generates per-channel metadata because `generateUpdatesFilesForAllChannels=true`.

Never overwrite the artifacts/metadata of an existing version. Increase the semantic version and publish a new tag so signatures, blockmaps, and checksums remain immutable.

## Rollback and incident response

The updater does not implement an automatic downgrade. If a release is bad:

1. stop promoting it and mark the GitHub release clearly;
2. publish a higher patch version containing the fix (for example `1.0.2`, not a republished `1.0.1`);
3. keep prior installers available for manual recovery if policy permits;
4. do not edit `latest*.yml` by hand or bypass signing/checksum verification;
5. investigate updater errors using sanitized Settings output and GitHub Release assets.

Application user data is separate from the installed bundle and should not be removed during an app reinstall. Back it up before any manual schema rollback.
