# paclink (Package Link Management)

Paclink manages persistent Debian→Arch virtual package name mappings.
Links are stored in the local DB and visible only to pacman/libalpm tools,
not dpkg.

## Commands

| Command | Description |
|---------|-------------|
| `paclink -Ln <deb> <virt>` | Create a link: Debian package `<deb>` provides Arch virtual name `<virt>` |
| `paclink -L` | List all links |
| `paclink -Ls <keyword>` | Search links by name or target |
| `paclink -Li <virt>` | Show link details |
| `paclink -R <virt>` | Remove a link (Debian package unaffected) |

## Examples

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

## Behavior

- Links are created as local DB entries with `repoType: link`.
- When a real package from any repo shares the same name as a link, the real
  package takes precedence and the link is automatically removed during
  installation.
- Links are only visible to pacman and libalpm — dpkg never sees them.

## Default Links

Setup creates the following default mappings:

| Virtual Name | Debian Package |
|-------------|----------------|
| sh | bash (or dash) |
| python | python3 |
| zlib | zlib1g |
| bzip2 | libbz2-1.0 |
| xz | liblzma5 |
| zstd | libzstd1 |
| openssl | libssl-dev |
| libssl | libssl3t64 |
| libcrypt | libcrypt1 |
| libffi | libffi8 |
| libpcre | libpcre3 |
| libpcre2 | libpcre2-8-0 |
| libpng | libpng16-16t64 |
| libjpeg-turbo | libjpeg62-turbo |
| freetype2 | libfreetype6 |
| ncurses | libncursesw6 |
| readline | libreadline8t64 |
| sqlite | libsqlite3-0 |
| expat | libexpat1 |
| libxml2 | libxml2 |
| glibc | libc6 |
| gcc-libs | libgcc-s1 |
| libstdc++ | libstdc++6 |
| systemd-libs | libsystemd0 |
| gnutls | libgnutls30t64 |
| libcurl | libcurl4t64 |
| ca-certificates-utils | ca-certificates |
