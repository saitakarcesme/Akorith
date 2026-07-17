# Akorith release checklist

Use this checklist for a tagged desktop release. It reflects the current Chat, Workspace, Loop,
Research, Benchmark, Plugins, Dashboard, and in-app update surfaces.

## 1. Preflight

- [ ] Bump `package.json` and `package-lock.json` to the intended release version.
- [ ] `npm run typecheck` passes.
- [ ] `npm run verify:research` passes every contract, input, network-safety, artifact, and
      persistence check.
- [ ] `npm run verify:research-seed` generates the complete provider-class × depth × output matrix
      in an isolated library.
- [ ] `npm run verify:research-live:check -- --provider all` reports which logged-in CLIs can run;
      unavailable providers are documented, not silently substituted.
- [ ] Workspace, Loop, controller, startup hydration, local runtime/executor, Goal cycle,
      OpenCode output, plugin tools, update-version, and Windows identity verifiers pass.
- [ ] `npm run build` passes.
- [ ] `npm run release:check` reports 0 errors and the intended tag is available.
- [ ] The working tree contains only intentional release changes; never stage `.env`, tokens,
      credentials, local databases, or generated `dist/` artifacts.

## 2. Functional smoke test

- [ ] **General Chat:** send a message, switch chats while it runs, return to the correct response,
      and verify the icon-only copy action.
- [ ] **Workspace:** open a real project, run a read-only plan and a small change, inspect the fixed
      Step popover, Changes diff, elapsed time, and live project preview where supported.
- [ ] **Loop:** open multiple Goal tabs, confirm the compact stage rail and evidence timeline, then
      pause/resume or complete one Goal without affecting another.
- [ ] **Research:** start independent tabs with explicit provider/model, depth, and output format;
      confirm planning, cited progress, pause/resume, recovery, and completion.
- [ ] **Research Library:** open a cover, inspect sources/claims, reveal the artifact, and visually
      check one PDF, DOCX, XLSX, and Markdown report. PDF/DOCX must not clip; XLSX must print one
      worksheet per fitted page with readable headings.
- [ ] **Dashboard:** profile navigation, Token activity, GitHub activity, and local compute telemetry
      render without horizontal overflow.
- [ ] **Benchmark / Plugins / Settings:** tables, original plugin identities, light theme, provider
      diagnostics, and Update all remain readable and functional.
- [ ] No provider API key is requested or stored. Provider calls use existing local CLI logins.

## 3. Package and install on macOS

- [ ] `npm run pack:mac` creates `dist/mac-arm64/Akorith.app` (and the Intel directory when built).
- [ ] Native modules exist under `app.asar.unpacked`; the `node-pty` `spawn-helper` is executable.
- [ ] `npm run refresh:mac` backs up the prior Akorith app, installs the new build at
      `/Applications/Akorith.app`, and leaves `~/Library/Application Support/Akorith/` untouched.
- [ ] The packaged app launches; Finder, Dock, menu bar, window title, About panel, and icon all say
      Akorith rather than Electron.
- [ ] Settings → Update shows the installed version and can check the stable GitHub release channel.

## 4. Windows artifact

- [ ] Build on Windows or through the release workflow; do not rely on macOS cross-building NSIS.
- [ ] Verify the NSIS installer and portable executable both carry Akorith name, icon, executable
      metadata, and shortcuts.
- [ ] Launch once with an available CLI and once with a missing CLI; the latter must show a clear
      unavailable state without crashing.

## 5. Publish

- [ ] Push the reviewed `main` commit.
- [ ] Create and push the annotated `vX.Y.Z` tag.
- [ ] Wait for every macOS arm64, macOS x64, and Windows matrix job to pass.
- [ ] Confirm the GitHub Release contains `.dmg`, `.zip`, and Windows `.exe` artifacts with the
      release version in each filename.
- [ ] Verify the in-app updater can see the new stable release and validates version, size, SHA,
      bundle identity, and downloaded artifact before installation.
- [ ] Keep the unsigned-build limitation visible until real signing/notarization secrets exist;
      never imitate or bypass signing.

## 6. Release notes

- [ ] Summarize user-visible changes, migration/recovery behavior, and known limitations.
- [ ] State which real provider smoke tests were run and which were blocked by missing/expired login.
- [ ] Link to `docs/install.md`, `docs/update-system.md`, and this checklist.
