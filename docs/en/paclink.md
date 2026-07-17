# paclink (Arch-to-Debian Mapping)

`paclink` provides Arch package names as virtual names for installed Debian
packages. This lets pacman-debian, libalpm, and AUR helpers resolve Arch
dependencies while the actual files remain managed by dpkg.

The default mapping source is maintained separately at
`https://github.com/xbodwf/paclinks`. The active mapping file is
`/var/lib/pacman-debian/paclinks`; installed Debian packages receive matching
`Provides:` entries in `/var/lib/dpkg/status`.

## Recommended Workflow

```bash
# Download the standalone mapping source
sudo paclink -Sy

# Rebuild mappings for installed Debian packages
sudo paclink -Syu
```

`-Syu` only activates a mapping when its Debian target is installed. If a
target is removed, the mapping is removed and paclink warns when an installed
Arch package still depends on that virtual name.

Use `-Su` to rebuild from the cached source without downloading, or `-Syyu` to
force a source refresh before rebuilding.

## Commands

| Command | Description |
|---------|-------------|
| `paclink -Sy` | Sync the mapping source |
| `paclink -Syy` | Force-sync the mapping source |
| `paclink -Su` | Rebuild mappings from the cached source |
| `paclink -Syu` | Sync and rebuild mappings |
| `paclink -Syyu` | Force-sync and rebuild mappings |
| `paclink -U <file>` | Install a local mapping source file |
| `paclink -Q` | List active mapping packages |
| `paclink -Qi [name]` | Show mapping package information |
| `paclink -Ql [name]` | List mapping records |
| `paclink -Qs <keyword>` | Search mapping packages |
| `paclink -Qo <deb>` | Find the Arch virtual name for a Debian package |
| `paclink -L` | List active links (legacy view) |
| `paclink -Ln <deb> <virt>` | Create a manual link |
| `paclink -R <virt>` | Remove a manual or active link |

## Configuration

Configuration is stored in `/etc/pacman-debian/paclink.conf`:

```ini
[options]
Color = auto
CacheDir = /var/cache/pacman-debian
Server = https://raw.githubusercontent.com/xbodwf/paclinks/main/paclinks.conf
```

`CacheDir` contains the downloaded source as `paclinks.conf`. The standalone
repository's source file uses one mapping per line:

```text
python python3
libcurl libcurl4t64
gtk4 libgtk-4-1
```

## Verification

Check active mappings:

```bash
sudo paclink -Q
```

Check the dpkg virtual provides written by paclink:

```bash
dpkg-query -W -f='${Package}: ${Provides}\n' libcairo2 libpango-1.0-0 libgtk-4-1 libpam0g
```

Simulate dependency resolution without changing the system:

```bash
sudo apt-get -s --no-remove install appstream
sudo apt-get check
```

`apt remove pacman` is not a mapping test. It deliberately removes the
virtual `pacman` package and causes APT to re-solve the whole mixed dependency
graph.

## Manual Links

Manual links remain available for local exceptions:

```bash
sudo paclink -Ln dash sh
paclink -L
paclink -Ls python
sudo paclink -R sh
```

The normal setup process no longer creates a full set of mappings. Use the
standalone source and `-Syu` so mappings follow the Debian packages actually
installed on the system.
