# Architecture

## Source Tree

```
src/
├── cli/
│   ├── pacman.ts            # CLI argument parsing and dispatch
│   ├── paclink.ts           # Virtual package link management
│   ├── pactree.ts           # Dependency tree viewer
│   ├── update-ca-trust.ts   # Arch-compat CA certificate updater
│   ├── archlinux-java.ts    # Arch-compat Java alternatives manager
│   └── fix_default.ts       # Arch-compat default JDK helper
├── core/                    # Package format parsers, dependency engine
│   ├── ar.ts                # ar archive parser
│   ├── tar.ts               # tar extractor (with progress callback)
│   ├── deb.ts               # .deb package parser
│   ├── pkgfile.ts           # .pkg.tar.zst parser
│   ├── compress.ts          # gz/xz decompression
│   ├── control.ts           # debian control file parser
│   ├── deps.ts              # Dependency resolution engine (verCmp built-in)
│   ├── logger.ts            # File logger
│   └── paclinks.ts          # Paclink mapping file (TS backend)
├── db/
│   ├── localdb.ts           # Directory-based local package DB
│   ├── database.ts          # DB wrapper with transactions
│   └── dpkg-compat.ts       # dpkg status file read/write (no dpkg command)
├── ops/
│   ├── install.ts           # Package installation
│   ├── remove.ts            # Package removal
│   ├── query.ts             # All -Q queries
│   └── upgrade.ts           # Sync + upgrade flow (dpkg-aware)
├── repo/
│   ├── repository.ts        # Repo sync, download, JSONL cache
│   └── config.ts            # pacman.conf parser with Include support
├── scripts/
│   └── setup.ts             # Interactive setup script
├── makepkg/
│   ├── index.ts             # Main makepkg entry
│   ├── pkgbuild.ts          # PKGBUILD parser (single-bash optimization)
│   ├── build.ts             # build()/package() execution (VCS support)
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
    ├── stubs_manual.c       # ~200 stubs for libalpm functions, idx search
    └── alpm_list.c          # Linked list implementation
```

## Database

### Local database: `/var/lib/pacman-debian/local/`

Directory-per-package format:

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
still see the package. **No `dpkg` command is ever invoked** — the status file
is parsed directly, and file lists are read from `/var/lib/dpkg/info/*.list`.

### Repository cache: `/var/cache/pacman-debian/packages/`

Each repository is cached in JSON Lines chunks (5000 packages per `.jsonl`
file). During sync, a `packages.idx` index is also built — one line per
package, sorted globally by name.

**Idx format (v2, since 7.4.0):**
```
pkgname version\tdescription\tprovides\tchunk\toffset
```

The version is embedded directly in the idx line, allowing `findInRepo()` and
search to return name + version without reading from the JSONL chunk.

```
/var/cache/pacman-debian/packages/
├── trixie/
│   ├── 00000.jsonl   # JSON Lines, ~5000 pkg per chunk
│   ├── ...
│   └── packages.idx  # Sorted index with version embedded
└── ...
```

#### Memory Index Cache

`packages.idx` is loaded **once** and cached permanently until
`invalidateIdxCache()` is called. No stat/mtime checks on subsequent lookups:

```
_idxCache = new Map<string, IdxEntry>();
IdxEntry { lines: string[], providesIndex: Map<string, Array<{chunkFile, offset}>> }
_pkgCache = new Map<string, RepoPkg>()  // LRU by chunkFile:offset
```

### Lookup Paths

| Operation | Method | Why |
|-----------|--------|-----|
| `-S <pkg>` / `-Qo` | Binary search `packages.idx` → seek JSONL | O(log N), single pread |
| `-Ss` | Line-scan `packages.idx` (name + desc + version) | ~500KB scan, cached reads |
| `-Sl` | Read `packages.idx` → seek each pkg | Lazy-load via index |
| Dependency provides | Scan `packages.idx` provides field | Index-only, no JSON parse |
| `-Qi` / `-Ql` | dpkg status or localdb | No cache involved |

## Version Comparison (built-in, no dpkg dependency)

Since **7.4.0**, the version comparison algorithm (`verCmp` in `src/core/deps.ts`)
is a pure TypeScript port of dpkg's C implementation (`libdpkg/version.c`):

```
verrevcmp(a, b):
  1. Skip non-digit prefixes, compare by character weight (order())
     order(c):
       digits → 0 (compared as integers below)
       letters → ASCII value
       '~' → -1 (sorts before everything)
       other → charCode + 256
  2. Skip leading zeros on digit groups
  3. Compare digit groups as integers
  4. Longer digit group wins
```

Epoch comparison: `epoch:a > epoch:b` → a wins (integer comparison).
Revision comparison: same algorithm applied to the `-revision` suffix.

This eliminates the only hard dependency on the `dpkg` command. The `dpkg`
binary is now entirely optional — only the dpkg status file is read.

## Paclink Mapping Backend

Since **7.4.0**, Debian→Arch package name mappings are stored in
`/var/lib/pacman-debian/paclinks` (plain text, sorted by virt name):

```
glibc libc6
go golang-go
libxtst libxtst6
python python3
```

The C libalpm shim reads this file directly at startup via `load_paclinks()`,
adding virtual names as `provides` on the corresponding dpkg packages.
No recompilation is needed to add new mappings. Use `paclink -I` to
initialize all common mappings from your installed Debian packages.

## Sync Flow (Release-based for Debian repos)

Since **7.4.0**, Debian repository sync follows apt's approach:

1. Download `InRelease` / `Release` file with `If-Modified-Since`
2. If 304 → repo is up to date
3. Parse SHA256 hashes from Release file
4. For each component (`main`, `universe`, etc.), compare SHA256 with cached
   values from the previous sync
5. Only download new `Packages.xz`/`Packages.gz` when SHA256 differs
6. Save new SHA256 in `.info` for next sync

This eliminates false `notModified` returns from `If-Modified-Since` on
Packages files that haven't changed but where the Release metadata is newer.

## Dependency Engine

The dependency resolver (`src/core/deps.ts`) handles:

- Package name parsing with version constraints (`>=`, `<=`, `=`)
- OR dependencies (`|`)
- Architecture qualifiers (e.g. `:arm64`, `:amd64`)
- Both Debian (comma-separated) and Arch (space-separated) formats
- BFS resolution with pre-loaded DB state
- Conflict detection across installed and to-be-installed packages
- System package protection (glibc, libc6, etc.)
- dpkg-aware upgrade scanning: also checks apt-installed packages against
  Debian repo updates

### Performance Optimizations

| Technique | Description |
|-----------|-------------|
| **idx memory cache** | `findInRepo()` binary search on `_idxCache.lines[]` in memory (loaded once) |
| **provides inverted index** | `findProvider()` does `Map.get()` O(1) |
| **BFS + cursor** | Dependency queue uses index pointer instead of `shift()` |
| **batch head-tail scan** | Binary searches sorted idx from both ends simultaneously |
| **keep-alive HTTP** | Shared `https.Agent({ keepAlive: true, maxSockets: 8 })` |
| **async .gz decompress** | Non-blocking zlib with callback |
| **304 conditional requests** | Sync sends `If-Modified-Since`, skip unchanged repos |
| **Release-based SHA256 check** | Only download Packages when content actually changed |
| **Package read cache** | `_pkgCache` caches `readPkgAt()` results by chunk+offset |
| **Single-bash PKGBUILD parse** | Source once, export all variables (was 35 separate forks) |

## Repository Support

- **Debian/Ubuntu**: Reads `Packages.gz` / `Packages.xz` from standard
  repository indices. Supports `$repo`/`$arch` variable substitution.
  Release-based SHA256 validation before downloading.
- **Arch Linux**: Reads `db.tar.gz` from Arch-compatible repositories.
  Downloaded `.pkg.tar.zst` files are extracted and installed.
- **Arch ARM**: Binary packages require glibc 2.38+ — Debian 12 ships 2.36.
  Use `makepkg` for local builds instead.

## Project Status

Key features:

- **Performance**: `packages.idx` with embedded version enables sub-100ms
  search across 3000+ packages; idx is loaded once and cached in memory.
- **Zero dpkg dependency**: Version comparison algorithm ported from libdpkg,
  dpkg status read directly, no `dpkg` command required.
- **Parallel sync**: Repos sync concurrently with per-repo progress display.
- **64-bit indexed binary search**: Sorted idx enables O(log N) single-package lookup.
- **i18n**: Full Chinese and English localization via `$LANG` detection.
- **Color**: Matching official pacman color scheme.
- **Root check**: Query commands work without root; write operations require `sudo`.
- **Link system** (`paclink`): Debian→Arch virtual package name mappings stored
  in file backend, read by C shim at startup.
- **makepkg**: VCS source support (git, hg), parallel downloads, progress bars.
- **Release-based sync**: SHA256-validated Debian repo updates (like apt).
- **XferCommand**: Custom download commands (aria2c, curl, wget).
- **CheckSpace**: Configurable disk space verification before install.
- **IgnorePkg / NoUpgrade / NoExtract**: Standard pacman config options supported.
- **VerbosePkgLists**: Tabular package listing with version, repo, size columns.
- **CleanMethod**: `KeepInstalled` / `KeepCurrent` cache cleaning policy.
- **Downgrade protection**: Version comparison handles epochs, revisions, `~`
  (pre-release), and all dpkg version semantics.

Key limitations:

- **Arch ARM binary repos require glibc 2.38+** — Debian 12 ships 2.36.
- **yay/AUR**: libalpm stub library works for search and dep resolution, but
  complex AUR dependency chains may fail due to Debian/Arch naming differences.
