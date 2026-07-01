# Phase 56 — Finalize: push, reinstall newest build, cleanup

**Date:** 2026-07-01

## 1. Pushed commits
- Pushed **71 Phase 56 commits** to `origin/main` (`https://github.com/saitakarcesme/Akorith.git`):
  `cb5c2e7..54d6b8c  main -> main`.
- After push: working tree clean, `git rev-list --count origin/main..HEAD` = **0** (up to date).

## 2. Latest source SHA (embedded in the packaged app)
- The 71 Phase 56 test commits ended at `54d6b8c`. This finalize commit is added on top of them on
  `main`; it becomes the new HEAD.
- The packaged app is rebuilt from **HEAD (this finalize commit)** so the app's embedded
  `build-info.gitCommitFull` equals `git rev-parse HEAD`. Verified equal after install (§4).

## 3. Installed app copies found (before cleanup)
System-wide search of `/Applications ~/Applications ~/Desktop ~/Downloads ~/Documents`
(`*Akorith*.app`, `*Electron*.app`, `*Akorith*.dmg/.zip`):
- `/Applications/Akorith.app` — embedded `cb5c2e7` (pre-fix build).
- No other copies, no `~/Desktop/Akorith-old-apps-*` backups, no stray DMGs/zips, no Electron.app copies.

## 4. Rebuild + reinstall
- `npm run dist:mac` → built `dist/mac-arm64/Akorith.app` + dmg + zip. Code signing skipped
  (no Developer ID identity on this Mac — ad-hoc signed; expected for local install).
- `npm run refresh:mac` → moved the old `/Applications/Akorith.app` to a timestamped Desktop
  backup, then installed the new build to `/Applications/Akorith.app`.
- **Verified installed app** embeds **HEAD** (`build-info.gitCommitFull == git rev-parse HEAD`),
  name `Akorith`, id `com.akorith.app`, icon `Contents/Resources/icon.icns` (Akorith icon, 1.63 MB
  — matches `build/icon.icns`). No Electron name/icon in bundle metadata.
- (The build+install was run twice: first to embed `54d6b8c`, then re-run after this finalize
  commit so the installed app matches the final HEAD. Each run's backup was deleted — see §5.)

## 5. Old app copies permanently deleted
- `~/Desktop/Akorith-old-apps-20260701-215732/` — the old **cb5c2e7** build (280 MB) — permanently
  removed (`rm -rf` on that path only).
- `~/Desktop/Akorith-old-apps-20260701-220104/` — the intermediate **54d6b8c** build (280 MB),
  backed up during the second reinstall — permanently removed.
- Final sweep afterward: only `/Applications/Akorith.app` (newest, embeds HEAD) + the repo's
  gitignored `dist/` build output remain. No other Akorith/Electron app copies anywhere.

## 6. Source assets / old logos / Electron traces
**Audited — nothing needed removing; source is already clean.**
- Tracked image/icon assets: `assets/akorith-icon.svg`, `assets/akorith-logo.png`,
  `src/renderer/public/akorith-icon.svg`, `src/renderer/public/akorith-logo.png`,
  `build/icon.icns|ico|png`, plus `docs/screenshots/*` and `docs/validation/*`. **All are current
  Akorith assets and actively referenced** (`src/main/index.ts` window icon, `src/renderer/index.html`
  favicon, `icons.tsx` inline mark, electron-builder `mac.icon`/`buildResources`). No old logo/icon
  variants, no Electron placeholder assets, no `*old*`/`*legacy*` asset files exist.
- App identity is correct everywhere: `<title>Akorith`, `package.json` name `akorith` /
  productName `Akorith`, bundle `com.akorith.app`. No user-visible Electron name/icon.

## 7. Electron / "Loopex" references intentionally KEPT (required)
- **Electron runtime**: `electron`, `electron-vite`, `electron-builder`, `@electron-toolkit`,
  `electron.vite.config.ts`, and the bundled `Electron Framework.framework` inside the .app — these
  ARE the app framework; required.
- **`loopex.db`** (`src/main/db.ts`) and **`loopex.config.json`** (`src/main/config.ts`) — the real
  userData database + config **filenames**. Renaming would orphan existing user/test data. Kept.
- **`src/main/startupSnapshot.ts`** legacy list `['Electron','letsgetit','Loopex','Akorith']` —
  migrates data from OLD userData folder names into the Akorith userData folder. Critical for not
  losing legacy data. Kept.
- Internal technical names (`loopex-testlab` sandbox dir, `[loopex]` log prefixes, `LoopexConfig`
  type, `loopExecutorKind`) — internal, not user-visible branding. Kept (per "keep Electron/Loopex
  where technically relevant").
- `SettingsCenter.tsx` mention of `loopex.config.json` — factually correct (tells the user the real
  config filename); kept.

## 8. Data safety (explicitly NOT touched)
- `~/Library/Application Support/Akorith/` userData — untouched.
- `~/Library/Application Support/Akorith/loopex.db` — untouched (present, verified).
- Phase 56 test data (7 loops + runs, 2 companions + memories/sessions, 16 agents + runs/artifacts),
  `~/Desktop/projects/business/aiarticle` + sandboxes — all untouched.

## 9. Verification commands
```
git rev-list --count origin/main..HEAD            # 0
git rev-parse HEAD                                 # 54d6b8c...
node -e "require('@electron/asar').extractFile('/Applications/Akorith.app/Contents/Resources/app.asar','build-info.json').toString()"  # 54d6b8c
/usr/libexec/PlistBuddy -c 'Print :CFBundleName' /Applications/Akorith.app/Contents/Info.plist    # Akorith
npm run typecheck && npm run verify:companions && npm run verify:agents && npm run verify:project-loop && npm run verify:startup-hydration && npm run verify:local-runtime   # all ok
```

## Result
Newest source (54d6b8c, incl. Phase 56 F-3 + F-4 fixes) pushed to GitHub and packaged into
`/Applications/Akorith.app`. Old app copy removed. Source already free of stale branding/assets.
All userData and Phase 56 test data preserved.
