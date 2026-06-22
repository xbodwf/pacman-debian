# Installation

## Requirements

- Node.js 18+
- Debian-based distribution (Debian, Ubuntu, Armbian, Linux Mint, etc.)
- Root privileges for install, remove, and upgrade operations
- Build essentials: `gcc`, `make`, `ldconfig` (for libalpm C library, optional)

## npm Install (Recommended)

```bash
npm install -g pacman-debian@latest
sudo $(which pacman-debian-setup)
```

> [!WARNING]
> `npm install -g` **must** be run under `sudo` or as the `root` user.
> If you install as a regular user, Node.js will place `pacman-debian` into
> your home directory (`~/.npm-global/` or similar), making it susceptible to
> tampering, malicious modification, or breakage by other users or scripts on
> the system. Always use `sudo npm install -g`.

### What setup does

1. Creates default config `/etc/pacman-debian/pacman.conf`
2. Creates `/etc/pacman.conf` → `/etc/pacman-debian/pacman.conf` symlink
3. Creates CLI symlinks (`/usr/local/bin/pacman`, `makepkg`, `pacman-conf`, `paclink`, `update-ca-trust`, `archlinux-java`, `fix_default`)
4. Creates `/var/lib/pacman` → `/var/lib/pacman-debian` symlink for fastfetch detection
5. Installs Arch-compat helper tools (`update-ca-trust`, `archlinux-java`, `fix_default`)
6. Installs Arch-compat shell functions (`/etc/profile.d/append_path.sh`)
7. Registers a virtual `pacman` package in dpkg status
8. Creates default paclink mappings (sh → bash, python → python3, etc.)

## Development Install

```bash
git clone https://github.com/xbodwf/pacman-debian.git
cd pacman-debian
pnpm install
pnpm build                # tsc + C library
sudo node dist/scripts/setup.js
```

Or set up manually:

```bash
sudo ln -sf "$PWD/dist/cli/pacman.js" /usr/local/bin/pacman
sudo ln -sf "$PWD/dist/cli/paclink.js" /usr/local/bin/paclink
sudo ln -sf "$PWD/dist/scripts/pacman-conf.js" /usr/local/bin/pacman-conf
sudo ln -sf "$PWD/dist/makepkg/index.js" /usr/local/bin/makepkg
```

## First Use

```bash
# Sync repositories
sudo pacman -Sy

# Search
pacman -Ss neofetch

# Install
sudo pacman -S neofetch
```

See [Usage](usage.md) for full command reference.
