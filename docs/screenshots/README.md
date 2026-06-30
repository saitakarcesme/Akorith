# Akorith — Screenshot Checklist

Drop current PNG screenshots into this folder and reference them from the top-level
`README.md`. Capture on a **clean/demo profile** (no private projects, real chat
content, tokens, or personal paths) so the public README stays safe to share.

## Why not auto-captured

Akorith runs against your local SQLite (`loopex.db`), so a live window shows your real
projects and conversations. Rather than risk publishing private content, screenshots are
captured manually from a clean state. To get a clean state quickly, you can point Akorith at
a throwaway user-data dir, or temporarily move `~/Library/Application Support/akorith` aside
(it is never deleted by Akorith), capture, then restore it.

## Shots to capture (suggested filenames)

| File | Surface | Notes |
| --- | --- | --- |
| `workspace.png` | Workspace: sidebar + chat composer + agent drawer | Show the decluttered composer (model picker · target · More · Send) |
| `composer-more.png` | Composer "More" popover open | Image / Suggest / Repo / Auto-Enter / Summarize / Show agents |
| `sidebar.png` | Sidebar projects + chats | Folder icons, three-dot menus, resizable width |
| `dashboard.png` | Dashboard | Usage stats, **Claude/Codex usage-limit cards**, GPU, controller/plugins |
| `plugins.png` | Plugins page | Registry + diagnostics |
| `settings-update.png` | Settings → Update | Branch/commit/behind, Check + Update buttons |
| `settings-api.png` | Settings → API | Controller (loopback-only, token-protected) |
| `agents.png` | Agent Activity drawer | Olympus / Gaia / Atlantis terminals |
| `testlab.png` | Test Lab | Generate/run tests + report |

## How to capture (macOS)

- Window shot: `⌘⇧4` then `Space`, click the Akorith window (clean drop-shadow PNG).
- Or `screencapture -o -w docs/screenshots/<name>.png` (no shadow), then click the window.

After adding images, uncomment/extend the image block in the top-level `README.md`.
