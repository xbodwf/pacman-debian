# Configuration

Configuration file: `/etc/pacman-debian/pacman.conf`

The configuration uses pure Arch Linux pacman syntax with `Include` directives.
Repo-specific keys (`Type`, `Dist`, `Components` for Debian repos) go in
included files under `/etc/pacman.d/`.

## Example

```ini
[options]
Architecture = auto

[bookworm]
Include = /etc/pacman.d/debian-bookworm

[extra]
Include = /etc/pacman.d/arch-extra
```

Include file `/etc/pacman.d/debian-bookworm`:

```
Server = https://mirrors.tuna.tsinghua.edu.cn/debian
Type = debian
Dist = bookworm
Components = main contrib non-free non-free-firmware
```

Include file for Arch repos `/etc/pacman.d/arch-extra`:

```
Server = http://mirror.archlinuxarm.org/$arch/$repo
Type = arch
Architecture = auto
```

## Repo Types

### Debian

| Key | Required | Description |
|-----|----------|-------------|
| `Server` | Yes | Mirror URL (supports `$repo`, `$arch` substitution) |
| `Type` | Yes | Must be `debian` |
| `Dist` | Yes | Distribution codename (e.g., `bookworm`, `trixie`) |
| `Components` | Yes | Space-separated component list (`main contrib non-free`) |

### Arch

| Key | Required | Description |
|-----|----------|-------------|
| `Server` | Yes | Mirror URL (supports `$repo`, `$arch` substitution) |
| `Type` | Yes | Must be `arch` |
| `Architecture` | No | Set to `auto` to match system arch |

## Symlink

A symlink at `/etc/pacman.conf` → `/etc/pacman-debian/pacman.conf` is created
during setup for compatibility with tools that hardcode this path (e.g., yay).

## Viewing Parsed Config

Use `pacman-conf` to view the configuration with all `Include` files resolved
and `$repo`/`$arch` variables substituted:

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
