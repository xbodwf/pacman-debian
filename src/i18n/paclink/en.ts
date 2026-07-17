const _messages: Record<string, string> = {
  link_created: "Link created: {0} {1} → {2}",
  link_removed: "Link removed: {0} (Debian package {1} unaffected)",
  apt_removed: "Debian package {0} removed.",
  apt_remove_failed: "Failed to remove Debian package {0}: {1}",
  link_skipped: "Link already exists: {0} → {1} (same mapping, skipped)",
  link_overwritten: "Link updated: {0} → {1} (was {2})",
  link_exists: 'Error: virtual package "{0}" already linked (target: {1})',
  link_not_found: 'Error: link "{0}" not found',
  deb_not_installed: 'Error: Debian package "{0}" is not installed',
  deb_not_installed_hint: "Install: sudo apt install {0}",
  confirm_init: "Create {0} paclink mappings based on installed Debian packages?",
  need_virt_name: "Error: need <deb_pkg> and <virt_name> arguments",
  no_links: "No links. Use paclink -Ls <deb_pkg> <virt_name> to create.",
  no_link_match: 'No links matching "{0}".',
  re_link_hint: "To re-link, first: paclink -R {0}",
  confirm_create: "Create link: {0} → {1} (= {2})",
  confirm_overwrite: "Link {0} already points to {1}. Overwrite to {2}?",
  confirm_remove: "Remove link: {0} → {1}",
  confirm_pacman_remove: "Also remove via pacman -R {0}?",
  confirm_apt_remove: "Also remove Debian package {0} via apt?",
  confirm_prompt: "[Y/n] ",
  cancelled: "Cancelled.",
  usage: "Usage:",
  usage_L: "Usage: paclink -L | paclink -Li <virt_name>",
  usage_Ls: "Usage: paclink -Ls <keyword>",
  usage_Ln: "Usage: paclink -Ln <deb_pkg> <virt_name>",
  usage_Li: "Usage: paclink -Li <virt_name>",
  usage_R: "Usage: paclink -R <virt_name>",
  need_root_create: "create link",
  need_root_remove: "remove link",
  help_text: `paclink v{0} — Map Debian packages to Arch virtual package names

Operations:
  -Sy / -Syy                 Sync mapping source / force refresh
  -Su / -Syu / -Syyu         Rebuild mappings from cached source
  -U <paclinks.conf>         Install a mapping source file
  -Q                         List active mapping packages
  -Qi [name]                 Show mapping package information
  -Ql [name]                 List mapping records
  -Qs <keyword>              Search mapping packages
  -Qo <deb_pkg>              Show Arch names provided by a Debian package
  -Ln <deb_pkg> <virt_name>  Create link (maps Debian package to Arch virtual name)
  -L                         List all links
  -Ls <keyword>              Search links
  -Li <virt_name>            Show link info
  -R <virt_name>             Remove link

Examples:
  paclink -Sy                Sync the standalone mapping source
  paclink -Syu               Activate mappings for installed Debian packages
  paclink -Ln dash sh        Map dash as sh
  paclink -Ln bash sh        Map bash as sh
  paclink -Ln python3 python Map python3 as python
  paclink -L                 List all links
  paclink -Ls python         Search links with 'python'
  paclink -Li sh             Show sh link info
  paclink -R python          Remove python link

Arguments:
  --noconfirm    Skip confirmation
  --help         Show this help
`,
  link_info_name: "Name     : {0}",
  link_info_provides: "Provides : {0}",
  link_info_version: "Version  : {0}",
  link_info_target: "Target   : {0}",
  link_info_desc: "Desc     : {0}",
  link_info_time: "Installed: {0}",
  error_need_root: "Error: {0} requires root privileges",
  unknown_op: 'Error: unknown operation "{0}"',
  error_prefix: "error: {0}",
  source_up_to_date: ":: paclink source is up to date: {0}",
  syncing_source: ":: Synchronizing paclink database...",
  source_download_start: " paclinks",
  source_downloaded: ":: Synchronized {0} mapping rules",
  source_missing: "error: no cached paclink source; run paclink -Sy first",
  source_invalid: "error: downloaded paclink source is empty or invalid",
  source_invalid_file: "error: invalid paclink mapping file: {0}",
  source_count: ":: Found {0} mapping rules",
  mapping_changes: "Packages ({0})",
  mapping_header: "  Name                 OldVer                 NewVer                 Debian Target",
  mapping_none: " there is nothing to do",
  mapping_remove_count: ":: Mappings to remove: {0}",
  mapping_new: "new",
  confirm_changes: ":: Apply mapping changes? [Y/n] ",
  mapping_removed: "warning: removed paclink {0} -> {1}; target package is not installed",
  mapping_depends: "warning: {0} still depends on virtual package {1}",
  mappings_active: ":: Active mappings: {0}",
  mappings_none: ":: No installed Debian targets match the mapping source",
  usage_sync: "Usage: paclink -Sy | -Syy | -Su | -Syu | -Syyu",
  usage_upgrade: "Usage: paclink -U <paclinks.conf>",
  query_no_packages: "error: no mapping packages found",
  query_no_match: 'No mapping packages match "{0}".',
  query_name: "Name            : {0}",
  query_version: "Version         : {0}",
  query_target: "Debian Target   : {0}",
  query_provides: "Provides        : {0}",
  query_reason: "Install Reason  : {0}",
  query_link_file: "Mapping         : {0} -> {1}",
  query_provided_by: "{0} provides: {1}",
  query_installed: "installed",
  query_mapping: "mapping",
  usage_query: "Usage: paclink -Q | -Qi [name] | -Ql [name] | -Qs <keyword> | -Qo <deb>",
  source_file_missing: "No {0} found. Run paclink -Sy or create one with Arch-to-Debian mappings.",
  source_file_example: "Example: glibc libc6",
  init_none: "No installed Debian targets match the mapping source.",
  init_found: ":: Found {0} installable mappings:",
  init_more: "  ... and {0} more",
  init_created: ":: Activated {0} paclink mappings.",
};

export default _messages;
