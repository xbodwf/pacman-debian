const _messages: Record<string, string> = {
  banner: '==> pacman-debian APT 源迁移',
  usage: '用法: sudo pacmigrate setup',
  need_root: 'pacmigrate setup 必须以 root 身份运行。',
  no_sources: '没有找到启用的 Debian/Ubuntu APT 源。',
  source_count: '找到 {0} 个启用的 APT 仓库。',
  backup_created: '现有 pacman.conf 已备份到 {0}',
  config_written: 'pacman-debian 配置已写入 {0}',
  source_skipped: '已跳过不支持或不完整的 APT 源：{0}',
  prompt_parallel: 'ParallelDownloads [默认: {0}]:',
  prompt_verbose: '启用 VerbosePkgLists？[y/N]:',
  prompt_color: '启用彩色输出？[Y/n]:',
  prompt_check_space: '启用 CheckSpace？[Y/n]:',
  prompt_confirm: '将这些 APT 源迁移到 pacman-debian？[Y/n]:',
  cancelled: '迁移已取消。',
  complete: '迁移完成。运行 sudo pacman -Sy 同步仓库。',
  error_prefix: '错误：{0}',
};

export default _messages;
