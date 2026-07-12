# Akorith production release checklist

This checklist is the short operational companion to
[Production updates and releases](production-updates-releases.md). The workflow is
fail-closed: do not manually upload replacement assets or bypass a native verification
job.

## 1. Prepare the release commit

- [ ] `package.json` and `package-lock.json` contain the same semantic version.
- [ ] Stable versions use `X.Y.Z`; beta versions use `X.Y.Z-beta.N`.
- [ ] `npm ci`, `npm run verify`, `npm run test:e2e`, `npm run build`, and
      `npm audit --omit=dev` pass from a clean checkout.
- [ ] `main` contains the exact release commit and has no uncommitted files.
- [ ] Release notes describe user-visible changes and any external prerequisites.

## 2. Configure protected credentials

- [ ] Windows Authenticode certificate and password secrets are configured.
- [ ] macOS Developer ID certificate/password and Apple notarization secrets are
      configured.
- [ ] No certificate, token, password, or notarization credential is committed.
- [ ] Required GitHub environments/branch protections allow the release workflow.

## 3. Tag and build

- [ ] Create the exact matching tag from `main`, for example `v1.2.3` or
      `v1.2.3-beta.1`, and push the tag without force.
- [ ] Windows produces the NSIS installer, portable executable, `latest.yml` or
      `beta.yml`, and installer blockmap.
- [ ] macOS arm64 produces the DMG, ZIP updater payload, `latest-mac.yml` or
      `beta-mac.yml`, and ZIP blockmap.
- [ ] Native packaged-launch, identity, signature, Gatekeeper/notarization, metadata,
      size, and checksum gates all pass.

## 4. Publish atomically

- [ ] The workflow creates a draft GitHub Release only after both native jobs pass.
- [ ] The transported inventory contains exactly the verified platform artifacts and
      release manifests.
- [ ] The draft inventory is revalidated before publication.
- [ ] The workflow finalizes the draft; existing releases are never overwritten.

## 5. Post-release acceptance

- [ ] Install the signed Windows NSIS build and the notarized macOS DMG build.
- [ ] Launch Workspace, Loop, Benchmark, Plugins, Dashboard, Remote Nodes, and Updates.
- [ ] From the previous signed version, exercise **Check -> Download -> Restart and
      install** against the new published release.
- [ ] Confirm the app identity, preserved user data, current version, release notes,
      stable/beta channel behavior, and sanitized failure messages.
- [ ] Confirm Windows portable reports manual replacement rather than auto-update.

## 6. Rollback

Do not republish or downgrade in place. Fix forward with a new higher version, repeat all
gates, and publish a new signed release. See the rollback section in the full production
runbook.
