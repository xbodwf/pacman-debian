# makepkg

A standalone `makepkg` implementation that builds Arch Linux packages from
PKGBUILDs without requiring `base-devel` or any Arch tools.

```bash
# Build a package from a PKGBUILD
cd /path/to/PKGBUILD/dir
makepkg --syncdeps --install
```

## Features

- Parses PKGBUILD via bash sourcing (`source PKGBUILD`) — supports all
  standard variables (`pkgname`, `pkgver`, `source`, `depends`, `makedepends`,
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

## Flags

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
