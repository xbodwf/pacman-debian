const _messages: Record<string, string> = {
  link_created: "链接创建成功: {0} {1} → {2}",
  link_removed: "链接已删除: {0}（Debian 包 {1} 不受影响）",
  apt_removed: "Debian 包 {0} 已删除。",
  apt_remove_failed: "Debian 包 {0} 删除失败: {1}",
  link_skipped: "链接已存在: {0} → {1}（相同映射，跳过）",
  link_overwritten: "链接已更新: {0} → {1}（原目标: {2}）",
  link_exists: '错误：虚拟包 "{0}" 已有链接（目标: {1}）',
  link_not_found: '错误：未找到链接 "{0}"',
  deb_not_installed: '错误：未安装 Debian 包 "{0}"',
  deb_not_installed_hint: "安装: sudo apt install {0}",
  confirm_init: "根据已安装的 Debian 包创建 {0} 条 paclink 映射？",
  need_virt_name: "错误：需要 <deb包> 和 <虚拟名> 两个参数",
  no_links: "没有链接。使用 paclink -Ls <deb包> <虚拟名> 创建。",
  no_link_match: '没有匹配 "{0}" 的链接。',
  re_link_hint: "如需重新链接，请先: paclink -R {0}",
  confirm_create: "创建链接: {0} → {1} (= {2})",
  confirm_overwrite: "链接 {0} 已指向 {1}，覆盖为 {2}？",
  confirm_remove: "删除链接: {0} → {1}",
  confirm_pacman_remove: "也通过 pacman -R {0} 删除？",
  confirm_apt_remove: "也通过 apt 删除 Debian 包 {0}？",
  confirm_prompt: "[Y/n] ",
  cancelled: "已取消。",
  usage: "用法:",
  usage_L: "用法: paclink -L | paclink -Li <虚拟名>",
  usage_Ls: "用法: paclink -Ls <关键词>",
  usage_Ln: "用法: paclink -Ln <deb包> <虚拟名>",
  usage_Li: "用法: paclink -Li <虚拟名>",
  usage_R: "用法: paclink -R <虚拟名>",
  need_root_create: "创建链接",
  need_root_remove: "删除链接",
  help_text: `paclink v{0} — 将 Debian 包映射到 Arch 虚拟包名

操作:
  -Sy / -Syy                 同步映射源 / 强制刷新
  -Su / -Syu / -Syyu         根据缓存映射源重建映射
  -U <paclinks.conf>         安装映射源文件
  -Q                         列出当前映射软件包
  -Qi [名称]                 显示映射软件包信息
  -Ql [名称]                 列出映射记录
  -Qs <关键词>              搜索映射软件包
  -Qo <Debian包>             显示 Debian 包提供的 Arch 名称
  -Ln <deb包> <虚拟名>   创建链接（映射 Debian 包到 Arch 虚拟包名）
  -L                     列出所有链接
  -Ls <关键词>           搜索链接
  -Li <虚拟名>           显示链接详情
  -R <虚拟名>            删除链接

示例:
  paclink -Sy                 同步独立映射源
  paclink -Syu                为已安装 Debian 包启用映射
  paclink -Ln dash sh         将 dash 映射为 sh
  paclink -Ln bash sh         将 bash 映射为 sh
  paclink -Ln python3 python  将 python3 映射为 python
  paclink -L                  列出所有链接
  paclink -Ls python          搜索含 python 的链接
  paclink -Li sh              查看 sh 链接详情
  paclink -R python           删除 python 链接

参数:
  --noconfirm   跳过确认
  --help        显示此帮助
`,
  link_info_name: "名称     : {0}",
  link_info_provides: "虚拟提供 : {0}",
  link_info_version: "版本     : {0}",
  link_info_target: "链接目标 : {0}",
  link_info_desc: "描述     : {0}",
  link_info_time: "安装时间 : {0}",
  error_need_root: "错误：{0} 需要 root 权限",
  unknown_op: '错误：未知操作 "{0}"',
  error_prefix: "错误：{0}",
  source_up_to_date: ":: paclink 映射源已经是最新：{0}",
  syncing_source: ":: 正在同步 paclink 软件包数据库...",
  source_download_start: " paclinks",
  source_downloaded: ":: 已同步 {0} 条映射规则",
  source_missing: "错误：没有缓存的 paclink 映射源，请先运行 paclink -Sy",
  source_invalid: "错误：下载的 paclink 映射源为空或格式无效",
  source_invalid_file: "错误：无效的 paclink 映射文件：{0}",
  source_count: ":: 找到 {0} 条映射规则",
  mapping_changes: "软件包 ({0})",
  mapping_header: "  名称                 旧版本                 新版本                 Debian 目标",
  mapping_none: " 今日无事可做",
  mapping_remove_count: ":: 将删除映射：{0} 条",
  mapping_new: "新建",
  confirm_changes: ":: 应用映射变化吗？[Y/n] ",
  mapping_removed: "警告：已删除 paclink {0} -> {1}，目标软件包未安装",
  mapping_depends: "警告：{0} 仍依赖虚拟软件包 {1}",
  mappings_active: ":: 当前生效映射：{0}",
  mappings_none: ":: 没有匹配映射源的已安装 Debian 目标包",
  usage_sync: "用法：paclink -Sy | -Syy | -Su | -Syu | -Syyu",
  usage_upgrade: "用法：paclink -U <paclinks.conf>",
  query_no_packages: "错误：没有找到映射软件包",
  query_no_match: "没有匹配“{0}”的映射软件包。",
  query_name: "名称           ：{0}",
  query_version: "版本           ：{0}",
  query_target: "Debian 目标    ：{0}",
  query_provides: "提供           ：{0}",
  query_reason: "安装原因       ：{0}",
  query_link_file: "映射           ：{0} -> {1}",
  query_provided_by: "{0} 提供：{1}",
  query_installed: "已安装",
  query_mapping: "映射",
  usage_query: "用法：paclink -Q | -Qi [名称] | -Ql [名称] | -Qs <关键词> | -Qo <Debian包>",
  source_file_missing: "未找到 {0}。请运行 paclink -Sy 或创建 Arch 到 Debian 的映射文件。",
  source_file_example: "示例：glibc libc6",
  init_none: "映射源中没有匹配已安装 Debian 软件包的目标。",
  init_found: ":: 找到 {0} 条可用映射：",
  init_more: "  ... 以及另外 {0} 条",
  init_created: ":: 已启用 {0} 条 paclink 映射。",
};

export default _messages;
