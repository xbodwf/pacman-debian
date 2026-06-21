const _messages: Record<string, string> = {
  link_created: "Link created: {0} {1} → {2}",
  link_removed: "Link removed: {0} (Debian package {1} unaffected)",
  link_skipped: "Link already exists: {0} → {1} (same mapping, skipped)",
  link_overwritten: "Link updated: {0} → {1} (was {2})",
  link_exists: 'Error: virtual package "{0}" already linked (target: {1})',
  link_not_found: 'Error: link "{0}" not found',
  deb_not_installed: 'Error: Debian package "{0}" is not installed',
  deb_not_installed_hint: "Install: sudo apt install {0}",
  need_virt_name: "Error: need <deb_pkg> and <virt_name> arguments",
  no_links: "No links. Use paclink -Ls <deb_pkg> <virt_name> to create.",
  no_link_match: 'No links matching "{0}".',
  re_link_hint: "To re-link, first: paclink -R {0}",
  confirm_create: "Create link: {0} → {1} (= {2})",
  confirm_overwrite: "Link {0} already points to {1}. Overwrite to {2}?",
  confirm_remove: "Remove link: {0} → {1}",
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
  -Ln <deb_pkg> <virt_name>  Create link (maps Debian package to Arch virtual name)
  -L                         List all links
  -Ls <keyword>              Search links
  -Li <virt_name>            Show link info
  -R <virt_name>             Remove link

Examples:
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
};

export default _messages;
