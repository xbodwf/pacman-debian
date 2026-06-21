# pacman-debian

A package manager that adopts the Arch Linux pacman command-line syntax while
operating directly on Debian/Ubuntu `.deb` packages. It manages packages at the
dpkg level — bypassing APT — and also supports native Arch Linux `.pkg.tar.zst`
packages (including AUR compatibility via yay with a bundled libalpm).

## Introduction

### Goals

- Provide a consistent, pacman-style CLI for package management on Debian-based
  systems, eliminating the conceptual overhead of switching between `apt`,
  `dpkg`, and their various frontends.
- Support multi-repository setups combining Debian/Ubuntu and Arch Linux
  repositories under a single tool.
- Maintain full compatibility with dpkg's database (`/var/lib/dpkg/status`),
  allowing coexistence with APT and other dpkg frontends.
- Provide a libalpm ABI-compatible shared library so that Go-based AUR helpers
  (yay) can work on Debian without modification.

### Project Status

This project was renamed to `pacman-debian` at v7.1.0. It is functional for
day-to-day package management on Debian-based distributions. Key features:

- **Performance**: `packages.idx` index enables sub-second single-package
  lookup. `-Ss` scans index only (no JSON parsing). Full `-Sl` uses index
  seek. ~64k packages across all repos, cached.
- **Parallel sync**: Repos sync concurrently with per-repo progress display.
  HTTP conditional requests (304) skip unchanged repos.
- **i18n**: Full Chinese and English localization via `$LANG` detection.
  Controlled by JSON message catalogs at `src/i18n/`.
- **Color**: Respects `Color` option in `pacman.conf [options]`. Matching
  official pacman color scheme (magenta=repo, green=pkg, red=error).
- **Root check**: Moved into CLI code — query commands (`-Q`, `-Ss`, `-Si`,
  `-Sp`, `-Rp`) work without root. Write operations require `sudo`.
- **Link system** (`paclink`): Debian→Arch virtual package name mappings stored
  as local DB entries (`repoType: link`). Real repo packages automatically
  take precedence over links during install. Links are only visible to
  pacman/libalpm, not dpkg.
- **Scoped i18n**: Each tool (pacman, paclink, setup) loads its own translation
  file at first use, reducing cold-start overhead. Languages: en, zh-CN.

Key limitations:

- **Arch ARM binary repos require glibc 2.38+** — Debian 12 ships 2.36.
  Local `makepkg` builds work fine.
- **yay/AUR**: libalpm stub library enables package search and dependency
  resolution, but complex AUR dependency chains may fail due to Debian/Arch
  package naming differences.
- **No AUR helper integration** beyond yay (paru, pamac, etc. untested).

## Installation

### Requirements

- Node.js 18+ (TypeScript, compiled with `tsc`)
- Debian-based distribution (Debian, Ubuntu, Armbian, Linux Mint, etc.)
- Root privileges for install, remove, and upgrade operations
- Build essentials: `gcc`, `make`, `ldconfig` (for libalpm C library)

### Quick Install (npm)

```bash
npm install -g pacman-debian@latest
sudo $(which pacman-debian-setup)
```

> [!WARNING]
> If you install pacman-debian outside of sudo/su (i.e. as a regular user with
> `npm install -g`), you acknowledge that pacman-debian and its associated
> scripts may be subject to unauthorized modification or compromise.

The setup script will:
1. Create `/etc/pacman-debian/pacman.conf` with default settings
2. Create `/etc/pacman.conf` → `/etc/pacman-debian/pacman.conf` symlink
3. Create all CLI symlinks (`/usr/local/bin/pacman`, etc.)
4. Set up `/var/lib/pacman` → `/var/lib/pacman-debian` symlink for fastfetch detection
5. Install Arch-compat helper tools (`update-ca-trust`, `archlinux-java`, `fix_default`)
6. Install Arch-compat shell functions (`/etc/profile.d/append_path.sh`)
7. Register a virtual `pacman` package in dpkg status
8. Create default paclink mappings (sh → bash, python → python3, etc.)

After setup, sync repositories and start using pacman:

```bash
sudo pacman -Sy
sudo pacman -S neofetch
```

### Development Install

```bash
git clone https://github.com/Xbodwf/pacman-debian.git
cd pacman-debian
pnpm install
pnpm build                # tsc + C library
# Or step by step:
pnpm exec tsc
make -C lib/pac4deb       # Build libalpm.so

# Run setup
sudo node dist/scripts/setup.js

# Or set up manually:
sudo ln -sf "$PWD/dist/cli/pacman.js" /usr/local/bin/pacman
sudo ln -sf "$PWD/dist/cli/paclink.js" /usr/local/bin/paclink
sudo ln -sf "$PWD/dist/scripts/pacman-conf.js" /usr/local/bin/pacman-conf
sudo ln -sf "$PWD/dist/makepkg/index.js" /usr/local/bin/makepkg
```

## Configuration

Configuration file: `/etc/pacman-debian/pacman.conf`

The configuration uses pure Arch Linux pacman syntax with `Include` directives.
Repo-specific keys (`Type`, `Dist`, `Components` for Debian repos) go in
included files under `/etc/pacman.d/`.

Example config:

```ini
[options]
Architecture = auto

[bookworm]
Include = /etc/pacman.d/debian-bookworm

[extra]
Include = /etc/pacman.d/arch-extra
```

Include file example (`/etc/pacman.d/debian-bookworm`):

```
Server = https://mirrors.tuna.tsinghua.edu.cn/debian
Type = debian
Dist = bookworm
Components = main contrib non-free non-free-firmware
```

Include file for Arch repos (`/etc/pacman.d/arch-extra`):

```
Server = http://mirror.archlinuxarm.org/$arch/$repo
Type = arch
Architecture = auto
```

A symlink at `/etc/pacman.conf` → `/etc/pacman-debian/pacman.conf` is created
during setup for compatibility with tools that hardcode this path (e.g., yay).

Use `pacman-conf` to view the parsed configuration with all `Include` files
resolved and `$repo`/`$arch` variables substituted:

```bash
$ pacman-conf
# pacman-debian configuration
[options]
Architecture = auto

[bookworm]
Server = https://mirrors.tuna.tsinghua.edu.cn/debian
Type = debian
Dist = bookworm
Components = main contrib non-free non-free-firmware

[extra]
Server = http://mirror.archlinuxarm.org/$arch/$repo
Type = arch
Architecture = auto
```

### Config Options

| Option | Description |
|--------|-------------|
| `Color` | Enable colored output (in `[options]` section) |
| `Architecture` | Set target architecture (default: `auto`) |
| `IgnorePkg` | Skip upgrade for specified packages |

## Architecture

### Source Tree

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

### Database

#### Local database: `/var/lib/pacman-debian/local/`

Uses a directory-per-package format matching Arch Linux's local DB:

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

A flat `index.json` file maps package names to their directories (one `name:base64path`
per line). This is the primary lookup path for removals and queries, and is
automatically rebuilt from the filesystem if missing or corrupted.

#### dpkg compatibility

Packages installed via `dpkg` or `apt` are read directly from
`/var/lib/dpkg/status` at query time (mtime-cached). When `pacman-debian`
installs a package, it writes a dpkg-compatible entry ensuring `apt` and `dpkg`
still see the package.

#### Repository cache: `/var/cache/pacman-debian/packages/`

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

**Lookup paths:**

| Operation | Method | Why |
|-----------|--------|-----|
| `-S <pkg>` / `-Qo` | Binary search `packages.idx` → seek JSONL | O(log N), single line read |
| `-Ss` | Line-scan `packages.idx` (name + desc) → seek JSONL | ~1.4MB scan, no JSON parse |
| `-Sl` | Read `packages.idx` → seek each pkg | Lazy-load via index |
| Dependency provides | Scan `packages.idx` provides field | Index-only, no JSON parse |
| `-Qi` / `-Ql` | dpkg status or localdb | No cache involved |

### Repository Support

- **Debian/Ubuntu**: Reads `Packages.gz` / `Packages.xz` from standard
  repository indices. Supports `$repo`/`$arch` variable substitution in
  `Server` URLs.
- **Arch Linux**: Reads `db.tar.gz` from Arch-compatible repositories.
  Downloaded `.pkg.tar.zst` files are extracted and installed.
- **Arch ARM**: Binary packages require glibc 2.38+ — most Debian-based
  distributions ship glibc 2.36 or older, so Arch ARM binary repos are
  **unusable** without a glibc upgrade (which will likely break the system).
  Use `makepkg` for local builds instead.

### libalpm C Library (libpac4deb)

A C library at `lib/pac4deb/` that implements the libalpm ABI (`alpm.h`),
allowing Go-based AUR helpers like `yay` to work on Debian without
modification. It reads:

- Local database (`/var/lib/pacman-debian/local/`) — packages installed by
  pacman-debian
- dpkg status (`/var/lib/dpkg/status`) — system packages from apt/dpkg
- Sync databases (`/var/cache/pacman-debian/packages/*/` — JSONL chunks)

Over 200 stubs are provided for rarely-used functions.

Key implementation details:

- **packages.idx binary search (C)**: `alpm_db_get_pkg` and `alpm_find_dbs_satisfier`
  use binary search on the sorted index, then read a single JSONL line by byte
  offset — no full JSONL loading.
- **Auto-register sync DBs**: `ensure_syncdbs` scans `/var/cache/pacman-debian/packages/`
  on first `alpm_get_syncdbs`, registering all available repos lazily.
- **Package DB pointer**: `pkg_internal.db` field tracks owning database;
  `alpm_pkg_get_db` returns it, preventing `DB().Name()` nil dereference.
- **idx-based search**: `alpm_db_search` scans index lines for pattern matching
  instead of loading all packages. ~1.5s for -Ss with 6 repos / 15k packages.
- **dpkg Provides parsing**: `load_dpkg_status` reads the `Provides:` field from
  dpkg status, so Debian packages that declare virtual names (e.g. `7zip` → `p7zip`)
  are discoverable by yay via `alpm_pkg_has_provide`.
- **Local DB fallback**: `alpm_find_dbs_satisfier` searches the local database
  (via `alpm_find_satisfier`) after sync DBs, matching both package names and
  provides — yay can find `gnutls` via `libgnutls30t64`'s mapped provides.
- **find_in_idx provides scan**: After binary search by package name fails,
  scans the `provides` column of `packages.idx` so sync DB provides are matched
  (e.g. `libz.so` → `zlib` in Arch repos).
- **dpkg -S fallback**: For `lib*.so` SONAMEs not found anywhere, forks `dpkg -S`
  to locate the owning Debian package at runtime.
- **Debian alternatives**: at local DB load time, checks `/etc/alternatives/` for
  `sh`, `awk`, `vi`, `editor` etc. and adds virtual provides to the owning package.

### Dependency Engine

The dependency resolver (`src/core/deps.ts`) handles:

- Package name parsing with version constraints (`>=`, `<=`, `=`)
- OR dependencies (`|`)
- Architecture qualifiers (e.g. `:arm64`, `:amd64`)
- Both Debian (comma-separated) and Arch (space-separated) formats
- BFS resolution with pre-loaded DB state
- Conflict detection across installed and to-be-installed packages
- System package protection (glibc, libc6, etc.)

- File validation: installed packages with no real files on disk (empty
  directories only) are considered NOT installed, forcing re-download.
- Explicit targets always have their dependencies processed even if the
  target itself is already installed.
- Queue uses `shift()` to pop processed items, preventing memory accumulation.

#### Performance Optimizations

| Technique | Description |
|-----------|-------------|
| **idx memory cache** | `findInRepo()` binary search on `_idxCache.lines[]` in memory, no file read (`src/repo/repository.ts:58`) |
| **provides inverted index** | `providesIndex` built at idx load time, `findProvider()` does `Map.get()` O(1) (`src/repo/repository.ts:69`) |
| **BFS + cursor** | Dependency queue uses index pointer instead of `shift()` to avoid array collapse overhead (`src/core/deps.ts:74`) |
| **resolved set dedup** | `Set<string>` prevents re-resolving the same dependency (`src/core/deps.ts:73`) |
| **batch head-tail scan** | `batchFindInRepo()` binary searches sorted idx from both ends simultaneously (`src/repo/repository.ts`) |
| **keep-alive HTTP** | Shared `https.Agent({ keepAlive: true, maxSockets: 8 })`, reuses TCP/TLS connections (`src/repo/repository.ts:22`) |
| **async .gz decompress** | `decompressAsync()` uses `zlib.gunzip()` callback, non-blocking (`src/core/compress.ts:9`) |
| **304 conditional requests** | Sync sends `If-Modified-Since`, server returns 304 → skip (`src/repo/repository.ts:96`) |

#### Delete Dependency Handling (`src/ops/remove.ts`)

| Operation | Logic |
|-----------|-------|
| `-R` | Remove specified package only, no dep handling |
| `-Rs` | Remove package + recursive orphan find (not RequiredBy any other pkg), reverse-topological order |
| `-Rc` | Cascade: find all packages that "require" the target, remove together |
| `-Rsc` | Recursive + cascade combination |
| `-Rn` | Backup conffiles from `/var/lib/dpkg/info/<pkg>.conffiles` as `.dpkg-old`, then remove |

Removal auto-sorts: dependents first (leaves before roots), so dependency
checks don't error. `isRequiredByOthers()` scans all installed packages'
`Depends` fields to determine if the target is needed.

### makepkg (`src/makepkg/`)

A standalone `makepkg` implementation that builds Arch Linux packages from
PKGBUILDs without requiring `base-devel` or any Arch tools.

```bash
# Build a package from a PKGBUILD
cd /path/to/PKGBUILD/dir
makepkg --syncdeps --install
```

Features:

- Parses PKGBUILD via bash sourcing (`source PKGBUILD`) — supports all
  standard variables (`pkgname`, `pkgver`, `source`, `depends`, `makedepps`,
  `sha256sums`, etc.)
- Downloads and verifies source files (supports http/https URLs with checksum
  verification)
- Extracts archives: `.tar.gz`, `.tar.xz`, `.tar.bz2`, `.tar.zst`, `.zip`
- Runs `prepare()`, `build()`, `check()`, and `package()` functions in a clean
  environment
- Creates `.pkg.tar.zst` archives with valid `.PKGINFO` metadata
- Dependency resolution via `--syncdeps` — installs missing dependencies
  through pacman-debian's sync databases (Debian and Arch repos)
- Supports `--install` (`-i`), `--clean` (`-c`), `--rmdeps`

| Flag | Description |
|------|-------------|
| `-s, --syncdeps` | Install missing dependencies via pacman |
| `-i, --install` | Install the built package |
| `-c, --clean` | Clean up build files after packaging |
| `-r, --rmdeps` | Remove installed dependencies after build |
| `-f, --force` | Overwrite existing package file |
| `-o, --nobuild` | Download and extract sources only (no build) |
| `--nocolor` | Disable colored output |
| `--printsrcinfo` | Print `.SRCINFO` and exit |

### Commands

#### Sync (-S)

| Command | Description |
|---------|-------------|
| `pacman -S <pkg>` | Install package(s) from repositories |
| `pacman -Sy` | Refresh package databases (mtime check, 24h) |
| `pacman -Syy` | Force refresh package databases |
| `pacman -Su` | Upgrade all installed packages |
| `pacman -Syu` | Refresh databases and upgrade |
| `pacman -Ss <keyword>` | Search repositories |
| `pacman -Si <pkg>` | Show remote package information |
| `pacman -Sl` | List all packages in repositories |
| `pacman -Sw <pkg>` | Download packages without installing |
| `pacman -Sc` | Remove unused cached packages |
| `pacman -Scc` | Remove all cached packages (including repos) |
| `pacman -Sp <pkg>` | Print what would be installed (dry-run) |

#### Remove (-R)

| Command | Description |
|---------|-------------|
| `pacman -R <pkg>` | Remove a package |
| `pacman -Rs <pkg>` | Remove package and unused dependencies |
| `pacman -Rn <pkg>` | Remove package and its config files (nosave) |
| `pacman -Rns <pkg>` | Remove package, dependencies, config files |
| `pacman -Rc <pkg>` | Cascade: remove packages that depend on the target |
| `pacman -Rdd <pkg>` | Skip dependency checks during removal |
| `pacman -Rp <pkg>` | Print what would be removed (dry-run) |

Multiple targets (`pacman -R a b`): all targets are merged and displayed
together, with a single confirmation prompt.

#### Query (-Q)

| Command | Description |
|---------|-------------|
| `pacman -Q` | List all installed packages |
| `pacman -Qe` | List explicitly installed packages |
| `pacman -Qd` | List packages installed as dependencies |
| `pacman -Qdt` | List orphan packages (unused dependencies) |
| `pacman -Qi <pkg>` | Show detailed package information |
| `pacman -Ql <pkg>` | List files owned by a package |
| `pacman -Qo <file>` | Query which package owns a file |
| `pacman -Qs <keyword>` | Search installed packages |
| `pacman -Qk [pkg]` | Verify installed package file integrity |

#### Other

| Command | Description |
|---------|-------------|
| `pacman -U <file>` | Install a local package file (.deb/.pkg.tar.zst) |
| `pacman -D --asdeps <pkg>` | Mark package as dependency |
| `pacman -D --asexplicit <pkg>` | Mark package as explicitly installed |
| `pacman -T <pkg>` | Check if dependencies are satisfied |
| `pacman -F <file>` | Search which package provides a file |
| `pacman -V` | Show version |

#### Bundled Tools

| Command | Description |
|---------|-------------|
| `pacman-conf` | Print parsed configuration (like Arch's `pacman-conf`). View resolved Server URLs, Type, Dist, Components for each repo. |
| `makepkg` | Build Arch Linux packages from PKGBUILD files. Supports `--syncdeps`, `--install`, `--clean`, source download, and `.pkg.tar.zst` creation. |
| `pacman-debian-setup` | Interactive setup: creates config, Include files, symlinks (`/etc/pacman.conf`, `/usr/local/bin/pacman`), and virtual `pacman` dpkg entry. |
| `paclink` | Create/manage persistent Debian→Arch virtual package name mappings. Links are stored in the local DB and visible only to pacman/libalpm tools, not dpkg. |
| `update-ca-trust` | Arch-compatible CA certificate updater (wraps Debian's `update-ca-certificates`) |
| `archlinux-java` | Java environment manager: `status`, `get`, `set`, `unset`, `fix` (wraps `update-alternatives`) |
| `fix_default` | Print current default JDK short name (used by Arch Java package install scripts) |

#### paclink (Link Management)

| Command | Description |
|---------|-------------|
| `paclink -Ln <deb> <virt>` | Create a link: Debian package `<deb>` provides Arch virtual name `<virt>` |
| `paclink -L` | List all links |
| `paclink -Ls <keyword>` | Search links by name or target |
| `paclink -Li <virt>` | Show link details |
| `paclink -R <virt>` | Remove a link (Debian package unaffected) |

Examples:

```bash
# Map dash to provide sh
sudo paclink -Ln dash sh

# Map python3 to provide python
sudo paclink -Ln python3 python

# List all mappings
paclink -L

# Search for links matching 'python'
paclink -Ls python
```

Links are created as local DB entries with `repoType: link`. When a real
package from any repo shares the same name as a link, the real package takes
precedence and the link is automatically removed during installation.

#### Global Flags

| Flag | Description |
|------|-------------|
| `--noconfirm` | Skip confirmation prompts |
| `--confirm` | Always ask for confirmation (default) |
| `--needed` | Do not reinstall packages that are already up-to-date |
| `--noscriptlet` | Do not execute install scripts |
| `--print` | Dry-run: show what would be done without executing |

### yay / AUR Support

`yay` works with `pacman-debian` through the bundled libalpm:

```bash
# Install yay (Go required)
sudo apt install golang-go
git clone https://aur.archlinux.org/yay.git /tmp/yay
cd /tmp/yay && go build -o /usr/local/bin/yay

# Use with pacman-debian
PACMAN=/usr/local/bin/pacman yay -Ss ponysay
PACMAN=/usr/local/bin/pacman sudo -E yay -S ponysay
```

Note: AUR packages that depend on `python` (not `python3`) are unresolvable
on Debian since the package is named `python3`. Install `python-is-python3`
or create a symlink to work around this.

## License

GNU General Public License v3.0
