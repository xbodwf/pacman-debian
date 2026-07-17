# libalpm & yay / AUR

## libalpm C Library (libpac4deb)

A C library at `lib/pac4deb/` that implements the libalpm ABI (`alpm.h`),
allowing Go-based AUR helpers like `yay` to work on Debian without
modification. It reads:

- Local database (`/var/lib/pacman-debian/local/`) — packages installed by
  pacman-debian
- dpkg status (`/var/lib/dpkg/status`) — system packages from apt/dpkg
- Sync databases (`/var/cache/pacman-debian/packages/*/` — JSONL chunks)
- Paclink mappings (`/var/lib/pacman-debian/paclinks`) — Debian→Arch name map

Over 200 stubs are provided for rarely-used functions.

### Key Implementation Details

- **packages.idx binary search (C)**: `alpm_db_get_pkg` and
  `alpm_find_dbs_satisfier` use binary search on the sorted index, then read
  a single JSONL line by byte offset — no full JSONL loading.
- **Paclink file backend**: Since 7.4.0, mappings are read from
  `/var/lib/pacman-debian/paclinks` (sorted text file) by `load_paclinks()`.
  No hardcoded table or recompilation needed. `libc6 → glibc`,
  `libxtst6 → libxtst`, `golang-go → go`, etc. are resolved at startup.
- **Auto-register sync DBs**: `ensure_syncdbs` scans
  `/var/cache/pacman-debian/packages/` on first `alpm_get_syncdbs`,
  registering all available repos lazily.
- **Package DB pointer**: `pkg_internal.db` field tracks owning database;
  `alpm_pkg_get_db` returns it, preventing `DB().Name()` nil dereference.
- **idx-based search**: `alpm_db_search` scans index lines for pattern
  matching instead of loading all packages. Sub-second for -Ss with 7 repos.
- **dpkg Provides parsing**: `load_dpkg_status` reads the `Provides:` field
  from dpkg status, so Debian packages that declare virtual names
  (e.g. `7zip` → `p7zip`) are discoverable by yay via
  `alpm_pkg_has_provide`.
- **Local DB fallback**: `alpm_find_dbs_satisfier` searches the local
  database after sync DBs, matching both package names and provides.
- **find_in_idx provides scan**: After binary search by package name fails,
  scans the `provides` column of `packages.idx` for sync DB provides.
- **Debian alternatives**: Checks `/etc/alternatives/` for `sh`, `awk`, `vi`,
  `editor` etc. and adds virtual provides to the owning package.
- **alpm_pkg_find**: Implemented (no longer a stub), searches linked list by
  name for yay's dependency resolution.

### Build

```bash
make -C lib/pac4deb
sudo make -C lib/pac4deb install
```

## yay / AUR Support

`yay` works with `pacman-debian` through the bundled libalpm:

```bash
# Install yay (Go required)
sudo apt install golang-go
git clone https://aur.archlinux.org/yay.git /tmp/yay
cd /tmp/yay && go build -o /usr/local/bin/yay

# Use with pacman-debian
yay -Ss ponysay
sudo pacman -S jdk21-openjdk   # yay also works for sync packages
```

Note: AUR packages that depend on `python` (not `python3`) are resolved via
paclink's `python → python3` mapping after running `sudo paclink -Syu`.
