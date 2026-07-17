const _messages: Record<string, string> = {
  banner: '==> pacman-debian source migration',
  usage: 'Usage: sudo pacmigrate setup',
  need_root: 'pacmigrate setup must be run as root.',
  no_sources: 'No enabled Debian/Ubuntu APT sources were found.',
  source_count: 'Found {0} enabled APT repositories.',
  backup_created: 'Existing pacman.conf backed up to {0}',
  config_written: 'pacman-debian configuration written to {0}',
  source_skipped: 'Skipped unsupported or incomplete APT source: {0}',
  prompt_parallel: 'ParallelDownloads [default: {0}]:',
  prompt_verbose: 'Enable VerbosePkgLists? [y/N]:',
  prompt_color: 'Enable Color output? [Y/n]:',
  prompt_check_space: 'Enable CheckSpace? [Y/n]:',
  prompt_confirm: 'Migrate these APT sources to pacman-debian? [Y/n]:',
  cancelled: 'Migration cancelled.',
  complete: 'Migration complete. Run sudo pacman -Sy to sync the repositories.',
  error_prefix: 'error: {0}',
};

export default _messages;
