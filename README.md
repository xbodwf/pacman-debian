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

Functional for day-to-day package management on Debian-based distributions.
See [Project Status](docs/en/architecture.md#project-status) for details.

## Installation

### Requirements

- Node.js 18+
- Debian-based distribution (Debian, Ubuntu, Armbian, Linux Mint, etc.)
- Root privileges for write operations
- Build essentials: `gcc`, `make`, `ldconfig` (for libalpm C library)

### Install

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

After setup:

```bash
sudo pacman -Sy
sudo pacman -S neofetch
```

### Development Install

```bash
git clone https://github.com/xbodwf/pacman-debian.git
cd pacman-debian
pnpm install && pnpm build
sudo node dist/scripts/setup.js
```

See [Installation](docs/en/installation.md) for details.

## Quick Start

```bash
# Search
pacman -Ss neofetch

# Install
sudo pacman -S neofetch

# Remove
sudo pacman -R neofetch

# Upgrade all
sudo pacman -Syu

# Query installed
pacman -Q
```

See [Usage](docs/en/usage.md) for complete command reference.

## Documentation

| Topic | English | 中文 |
|-------|---------|------|
| Usage (full command reference) | [docs/en/usage.md](docs/en/usage.md) | [docs/zh-CN/usage.md](docs/zh-CN/usage.md) |
| Configuration | [docs/en/configuration.md](docs/en/configuration.md) | [docs/zh-CN/configuration.md](docs/zh-CN/configuration.md) |
| Architecture & Database | [docs/en/architecture.md](docs/en/architecture.md) | [docs/zh-CN/architecture.md](docs/zh-CN/architecture.md) |
| makepkg | [docs/en/makepkg.md](docs/en/makepkg.md) | [docs/zh-CN/makepkg.md](docs/zh-CN/makepkg.md) |
| libalpm & yay/AUR | [docs/en/yay-aur.md](docs/en/yay-aur.md) | [docs/zh-CN/yay-aur.md](docs/zh-CN/yay-aur.md) |
| paclink (package links) | [docs/en/paclink.md](docs/en/paclink.md) | [docs/zh-CN/paclink.md](docs/zh-CN/paclink.md) |
| Installation (detailed) | [docs/en/installation.md](docs/en/installation.md) | [docs/zh-CN/installation.md](docs/zh-CN/installation.md) |

## License

GNU General Public License v3.0
