# Architecture

## Source Tree

```
src/
├── cli/
│   ├── pacman.ts            # CLI argument parsing and dispatch
│   ├── paclink.ts           # Virtual package link management
│   ├── update-ca-trust.ts   # Arch-compat CA certificate updater
│   ├── archlinux-java.ts    # Arch-compat Java alternatives manager
│   └── fix_default.ts       # Arch-compat default JDK helper
├── core/                    # Package format parsers, dependency engine
│   ├── ar.ts                # ar archive parser
│   ├── tar.ts               # tar extractor
│   ├── deb.ts               # .deb package parser
│   ├── pkgfile.ts           # .pkg.tar.zst parser
│   ├── compress.ts          # gz/xz decompression
│   ├── control.ts           # debian control file parser
│   └── deps.ts              # Dependency resolution engine
├── db/
│   ├── localdb.ts           # Directory-based local package DB
│   ├── database.ts          # DB wrapper with transactions
│   └── dpkg-compat.ts       # dpkg status file read/write
├── ops/
│   ├── install.ts           # Package installation
│   ├── remove.ts            # Package removal
│   ├── query.ts             # All -Q queries
│   └── upgrade.ts           # Sync + upgrade flow
├── repo/
│   ├── repository.ts        # Repo sync, download, JSONL cache
│   └── config.ts            # pacman.conf parser with Include support
├── scripts/
│   └── setup.ts             # Interactive setup script
├── makepkg/
│   ├── index.ts             # Main makepkg entry
│   ├── pkgbuild.ts          # PKGBUILD parser
│   ├── source.ts            # Source download/extraction
│   ├── build.ts             # build()/package() execution
│   └── printsrcinfo.ts      # .SRCINFO generation
├── ui/                      # User interface (prompt, formatting)
└── index.ts                 # Entry point
```

```
lib/pac4deb/                 # libalpm C library
├── Makefile                 # Build with gcc, target libalpm.so
├── include/
│   ├── alpm.h               # Public libalpm API header
│   └── alpm_list.h          # Linked list header
└── src/
    ├── libalpm.c            # Core implementation (handle, db, pkg, JSON parser)
    ├── stubs_manual.c       # ~200 stubs for rarely-used libalpm functions
    └── alpm_list.c          # Linked list implementation
```

## Database

### Local database: `/var/lib/pacman-debian/local/`

Directory-per-package format matching Arch Linux's local DB:

```
/var/lib/pacman-debian/local/
├── index.json       # name → dir mapping (base64 encoded paths)
├── by-name/
│   ├── fastfetch -> ../fastfetch-2.64.2-2/
│   └── ...
├── fastfetch-2.64.2-2/
│   ├── desc          # JSON metadata (name, version, deps, size, etc.)
│   └── files         # File manifest
└── ...
```

### dpkg compatibility

Packages installed via `dpkg` or `apt` are read directly from
`/var/lib/dpkg/status` at query time (mtime-cached). When `pacman-debian`
installs a package, it writes a dpkg-compatible entry ensuring `apt` and `dpkg`
still see the package.

### Repository cache: `/var/cache/pacman-debian/packages/`

Each repository is cached in JSON Lines chunks (5000 packages per `.jsonl`
file). During sync, a `packages.idx` index is also built — one line per
package, sorted globally, with format `pkgname description\tprovides\tchunk\toffset`.

```
/var/cache/pacman-debian/packages/
├── bookworm/
│   ├── 00000.jsonl   # JSON Lines, ~5000 pkg per chunk
│   ├── ...
│   └── packages.idx  # Global sorted index (tabs, ~200KB)
└── ...
```

#### Memory Index Cache

`packages.idx` is cached in memory after first read, keyed by repo name + mtime:

```
_idxCache = new Map<string, IdxEntry>();
IdxEntry { lines: string[], mtime: number, providesIndex: Map<string, Array<{chunkFile, offset}>> }
```

- Subsequent `-S`/`-Ss`/`-Sl` operations read from memory, no disk I/O
- `providesIndex` is an inverted index: `provides name → [{ chunkFile, offset }]`
  - `findProvider()` does O(1) `Map.get()` for provides lookups
- `pacman -Syy` clears the cache (`invalidateIdxCache()`)
- After incremental sync, idx file mtime changes → auto reload

### Lookup Paths

| Operation | Method | Why |
|-----------|--------|-----|
| `-S <pkg>` / `-Qo` | Binary search `packages.idx` → seek JSONL | O(log N), single line read |
| `-Ss` | Line-scan `packages.idx` (name + desc) → seek JSONL | ~1.4MB scan, no JSON parse |
| `-Sl` | Read `packages.idx` → seek each pkg | Lazy-load via index |
| Dependency provides | Scan `packages.idx` provides field | Index-only, no JSON parse |
| `-Qi` / `-Ql` | dpkg status or localdb | No cache involved |

## Dependency Engine

The dependency resolver (`src/core/deps.ts`) handles:

- Package name parsing with version constraints (`>=`, `<=`, `=`)
- OR dependencies (`|`)
- Architecture qualifiers (e.g. `:arm64`, `:amd64`)
- Both Debian (comma-separated) and Arch (space-separated) formats
- BFS resolution with pre-loaded DB state
- Conflict detection across installed and to-be-installed packages
- System package protection (glibc, libc6, etc.)

- File validation: installed packages with no real files on disk are
  considered NOT installed, forcing re-download.
- Explicit targets always have their dependencies processed even if the
  target itself is already installed.
- Queue uses `shift()` to pop processed items, preventing memory accumulation.

### Performance Optimizations

| Technique | Description |
|-----------|-------------|
| **idx memory cache** | `findInRepo()` binary search on `_idxCache.lines[]` in memory |
| **provides inverted index** | `findProvider()` does `Map.get()` O(1) |
| **BFS + cursor** | Dependency queue uses index pointer instead of `shift()` |
| **batch head-tail scan** | Binary searches sorted idx from both ends simultaneously |
| **keep-alive HTTP** | Shared `https.Agent({ keepAlive: true, maxSockets: 8 })` |
| **async .gz decompress** | Non-blocking zlib with callback |
| **304 conditional requests** | Sync sends `If-Modified-Since`, skip unchanged repos |

### Delete Dependency Handling

| Operation | Logic |
|-----------|-------|
| `-R` | Remove specified package only |
| `-Rs` | Remove package + recursive orphan find, reverse-topological order |
| `-Rc` | Cascade: find all packages requiring the target |
| `-Rsc` | Recursive + cascade combination |
| `-Rn` | Backup conffiles as `.dpkg-old`, then remove |

Removal auto-sorts dependents first (leaves before roots).

## Repository Support

- **Debian/Ubuntu**: Reads `Packages.gz` / `Packages.xz` from standard
  repository indices. Supports `$repo`/`$arch` variable substitution.
- **Arch Linux**: Reads `db.tar.gz` from Arch-compatible repositories.
  Downloaded `.pkg.tar.zst` files are extracted and installed.
- **Arch ARM**: Binary packages require glibc 2.38+ — Debian 12 ships 2.36.
  Use `makepkg` for local builds instead.

## Project Status

Key features:

- **Performance**: `packages.idx` index enables sub-second single-package lookup.
- **Parallel sync**: Repos sync concurrently with per-repo progress display.
- **i18n**: Full Chinese and English localization via `$LANG` detection.
- **Color**: Matching official pacman color scheme.
- **Root check**: Query commands work without root; write operations require `sudo`.
- **Link system** (`paclink`): Debian→Arch virtual package name mappings.

Key limitations:

- **Arch ARM binary repos require glibc 2.38+** — Debian 12 ships 2.36.
- **yay/AUR**: libalpm stub library works for search and dep resolution, but
  complex AUR dependency chains may fail due to Debian/Arch naming differences.
