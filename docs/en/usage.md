# Usage

## Sync (-S)

| Command | Description |
|---------|-------------|
| `pacman -S <pkg>` | Install package(s) from repositories |
| `pacman -Sy` | Refresh package databases (mtime check, 24h) |
| `pacman -Syy` | Force refresh package databases (clear memory idx cache) |
| `pacman -Su` | Upgrade all installed packages |
| `pacman -Syu` | Refresh databases and upgrade |
| `pacman -Ss <keyword>` | Search repositories |
| `pacman -Si <pkg>` | Show remote package information |
| `pacman -Sl` | List all packages in repositories |
| `pacman -Sw <pkg>` | Download packages to cache without installing |
| `pacman -Sc` | Remove unused cached package files |
| `pacman -Scc` | Clear entire cache (including repo jsonl/idx) |
| `pacman -Sp <pkg>` | Print download URL without installing |

## Remove (-R)

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
together with a single confirmation prompt.

## Query (-Q)

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
| `pacman -Qq` | Quiet mode: package names only, no versions |

## Other

| Command | Description |
|---------|-------------|
| `pacman -U <file>` | Install a local package file (.deb/.pkg.tar.zst) |
| `pacman -D --asdeps <pkg>` | Mark package as dependency |
| `pacman -D --asexplicit <pkg>` | Mark package as explicitly installed |
| `pacman -T <pkg>` | Check if dependencies are satisfied |
| `pacman -F <file>` | Search which package provides a file |
| `pacman -V` | Show version |

## Bundled Tools

| Command | Description |
|---------|-------------|
| `pacman-conf` | Print parsed configuration |
| `makepkg` | Build Arch Linux packages from PKGBUILD (see [makepkg](makepkg.md)) |
| `pacman-debian-setup` | Interactive setup script |
| `paclink` | Manage Debian→Arch virtual package name mappings (see [paclink](paclink.md)) |
| `update-ca-trust` | CA certificate updater (Arch-compat, wraps `update-ca-certificates`) |
| `archlinux-java` | Java environment manager: `status`, `get`, `set`, `unset`, `fix` |
| `fix_default` | Print current default JDK short name (used by Arch Java install scripts) |

## Global Flags

| Flag | Description |
|------|-------------|
| `--noconfirm` | Skip confirmation prompts |
| `--confirm` | Always ask for confirmation (default) |
| `--needed` | Do not reinstall up-to-date packages |
| `--noscriptlet` | Do not execute install scripts |
| `--print` | Dry-run: show what would be done without executing |

## Config Options (in `pacman.conf [options]`)

| Option | Description |
|--------|-------------|
| `Color` | Enable colored output |
| `Architecture` | Set target architecture (default: `auto`) |
| `IgnorePkg` | Skip upgrade for specified packages |

See [Configuration](configuration.md) for detailed config reference.
