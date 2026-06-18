# pac4deb-libalpm

A drop-in replacement for Arch Linux's `libalpm.so`, reading from pacman-debian's database (`/var/lib/pacman-debian/`). Enables native AUR helpers like `yay`, `expac`, `pkgfile` to run on Debian without modification.

## What is libalpm?

Arch Linux's package management core library (C). `pacman`, `yay`, `expac` and other Arch tools link against it to query databases, resolve dependencies, and manage transactions — all at the C API level rather than through the `pacman` CLI binary.

## How it works

```
yay ──────┐
expac ────┤
pkgfile ──┼─ libalpm.so (this project)
          │     ├─ reads /var/lib/pacman-debian/status.json
          │     ├─ reads /var/cache/pacman-debian/packages/*.json
          │     └─ wraps pacman-debian for transactions
          │
          └─ (real libalpm reads /var/lib/pacman/local/*/desc)
```

Instead of reading Arch's file-based package database, this library reads pacman-debian's JSON database and exposes the same C API. AUR helpers and other libalpm-dependent tools become usable on Debian without porting.

## Build

```bash
make
sudo make install
```

## API Coverage

Implements the most commonly used subset of libalpm's public API:

| Group | Functions |
|-------|-----------|
| Handle | `alpm_initialize`, `alpm_release` |
| Databases | `alpm_db_register_local`, `alpm_db_register_sync`, `alpm_db_unregister_all` |
| Package access | `alpm_db_get_pkg`, `alpm_db_get_pkgcache` |
| Package properties | `alpm_pkg_get_name`, `alpm_pkg_get_version`, `alpm_pkg_get_desc`, `alpm_pkg_get_url`, `alpm_pkg_get_arch`, `alpm_pkg_get_builddate`, `alpm_pkg_get_installdate`, `alpm_pkg_get_reason`, `alpm_pkg_get_base64_sig`, `alpm_pkg_free` |
| Lists | `alpm_list_add`, `alpm_list_remove`, `alpm_list_free`, `alpm_list_count`, `alpm_list_nth`, etc. |
| Options | `alpm_option_add_cachedir`, `alpm_option_set_dbpath`, `alpm_option_get_localdb`, `alpm_option_get_syncdbs` |
| Logging | `alpm_logaction`, `alpm_option_set_logfile` |

## License

GNU General Public License v3.0
