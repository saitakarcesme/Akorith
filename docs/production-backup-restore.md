# Restore the pre-rebuild backup

The safety backup root is `akorith_yedek` on the operating system's real Desktop. Each complete capture is stored in its own timestamp-named subdirectory. Do not assume a timestamp and do not restore over the current repository.

## Find a verified capture

On Windows PowerShell:

```powershell
$desktop = [Environment]::GetFolderPath('Desktop')
$root = Join-Path $desktop 'akorith_yedek'
$captures = Get-ChildItem -LiteralPath $root -Directory |
  Where-Object { $_.Name -match '^\d{8}-\d{6}$' } |
  Sort-Object LastWriteTime -Descending

$captures | ForEach-Object {
  $verification = Join-Path $_.FullName 'VERIFICATION.txt'
  [pscustomobject]@{
    Capture = $_.FullName
    Verified = (Test-Path -LiteralPath $verification) -and
      ((Get-Content -Raw -LiteralPath $verification) -match 'Git bundle verification: PASS')
  }
}
```

Choose a capture whose `VERIFICATION.txt` reports readable snapshot, Git bundle verification, bundle refs, and working-tree patch as `PASS`. Inspect these files before restoring:

- `RESTORE-README.md`: capture-specific source path, branch, local/origin commits, and commands;
- `EXCLUSIONS-MANIFEST.txt`: generated/ignored exclusions and file counts;
- `metadata/repository-state.txt`: original status/remotes/branches/tags;
- `metadata/local-commit.txt` and `metadata/origin-main-commit.txt`;
- `metadata/snapshot-sha256.tsv`;
- `metadata/untracked-included.txt`, if present;
- `metadata/tracked-deleted-from-working-tree.txt`, if present.

The backup directory may contain partial artifacts outside a timestamped capture. Treat only a timestamped directory with passing verification as authoritative.

## Verify again

```powershell
$capture = 'C:\path\to\the\chosen\timestamped-capture'
git bundle verify (Join-Path $capture 'akorith-complete.bundle')

$required = @(
  'akorith-complete.bundle',
  'working-tree.patch',
  'staged.patch',
  'unstaged.patch',
  'RESTORE-README.md',
  'EXCLUSIONS-MANIFEST.txt',
  'VERIFICATION.txt',
  'source-snapshot',
  'metadata'
)
$required | ForEach-Object {
  if (-not (Test-Path -LiteralPath (Join-Path $capture $_))) { throw "Missing backup item: $_" }
}
```

For a full hash audit, parse `metadata/snapshot-sha256.tsv`, hash each corresponding file beneath `source-snapshot`, and compare. The capture's own verification already records this result; repeat it before destructive disaster recovery if the media may have changed.

## Restore history and the captured dirty work

Use a new empty destination outside the current Akorith repository:

```powershell
$capture = 'C:\path\to\the\chosen\timestamped-capture'
$destination = 'C:\path\to\Akorith-restored'
$baseline = (Get-Content -Raw -LiteralPath (Join-Path $capture 'metadata\local-commit.txt')).Trim()

git clone (Join-Path $capture 'akorith-complete.bundle') $destination
Set-Location -LiteralPath $destination
git checkout --detach $baseline
git apply --binary (Join-Path $capture 'working-tree.patch')
git status --short
```

Then copy each relative path listed by `metadata/untracked-included.txt` from `source-snapshot` into the same relative destination. Preserve directories and do not copy ignored/generated roots from outside the capture.

Compare the result with `metadata/repository-state.txt`. The combined patch recreates working-tree content but not necessarily the original index split.

## Recreate staged versus unstaged changes

Only do this in another clean clone of the captured baseline:

```powershell
$capture = 'C:\path\to\the\chosen\timestamped-capture'
$destination = 'C:\path\to\Akorith-restored-index'
$baseline = (Get-Content -Raw -LiteralPath (Join-Path $capture 'metadata\local-commit.txt')).Trim()

git clone (Join-Path $capture 'akorith-complete.bundle') $destination
Set-Location -LiteralPath $destination
git checkout --detach $baseline

# Apply non-empty index patch to both index and worktree, then non-empty unstaged changes.
$staged = Join-Path $capture 'staged.patch'
$unstaged = Join-Path $capture 'unstaged.patch'
if ((Get-Item -LiteralPath $staged).Length -gt 0) { git apply --binary --index $staged }
if ((Get-Item -LiteralPath $unstaged).Length -gt 0) { git apply --binary $unstaged }
git status
```

An empty `staged.patch` is valid and means no staged delta existed. If a patch refuses to apply, stop and inspect it with `git apply --stat`/`git apply --check`; do not force it onto the wrong commit.

## Restore files without Git history

Copy `source-snapshot` to a new directory. It contains every tracked working-tree file captured plus included non-generated untracked files. Tracked deletions are represented in the patch and listed in metadata; a raw snapshot copy alone does not reproduce a deletion record or Git index state.

After copying, run the dependency/install commands appropriate to the captured revision. Excluded reproducible directories such as `node_modules`, `dist`, `out`, `build`, caches, coverage, and temporary roots should be regenerated, not recovered from another checkout.

## Restore only one file

Prefer copying the exact file from `source-snapshot` to a separate inspection directory, compare it with the current file, and apply the desired hunk manually. Do not replace a current source file blindly: the capture intentionally predates the rebuild.

## Return to the current implementation

The restoration procedures above never alter the current worktree or remote. Keep the restored checkout detached until it is inspected. If history from the bundle is needed later, add the bundle or restored clone as a temporary Git remote and fetch a named ref; do not force-push the historical baseline over current `main`.
