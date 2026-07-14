# pactree — Package Dependency Tree Viewer

`pactree` displays the dependency tree of a package, showing what it depends
on (forward) or what depends on it (reverse). It queries all available sources:
local database, dpkg status, and repository indexes.

## Usage

```
pactree [options] <package>
```

## Options

| Flag | Description |
|------|-------------|
| `-r`, `--reverse` | Show reverse dependencies (what depends on this package) |
| `-d`, `--depth` | Maximum tree depth (default: unlimited) |
| `-s`, `--sync` | Show version numbers |
| `-h`, `--help` | Show help |

## Examples

```bash
# Show what glibc depends on
pactree glibc

# Show what depends on glibc (reverse)
pactree -r glibc

# Limit depth to 2
pactree -d 2 python3

# Show with versions
pactree -s mesa
```

## Notes

- Circular dependencies are detected and marked with `(circular)`
- Missing packages are marked with `(not found)`
- The tree queries dpkg status, pacman-debian local DB, and sync repos
