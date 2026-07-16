# pacman-debian Problems

支持 `pkg=version` 和 `repo/pkg=version` 精确安装；未指定仓库时按仓库配置顺序查找，指定仓库时不会回退到其他仓库。

本文档记录当前已确认的问题、实现缺口和后续改进方向。问题按优先级排列；其中 P0/P1 会直接影响系统安全性、事务一致性或日常包管理可靠性。

## P0: 必须优先处理

### P0-1 Arch 包安装后的 dpkg 元数据不完整

状态：已修复新安装包的主要字段映射；历史包需要重新安装或从原始包重新导入才能补齐元数据。

安装 `.pkg.tar.zst` 后写入 `/var/lib/dpkg/status` 时，当前主要使用 pacman 元数据，但没有完整映射 Arch 包的 `.PKGINFO` 字段。

已观察到：

- `Section` 变成 `unknown`
- `Maintainer` 变成 `Unknown`
- `Installed-Size` 变成 `0`
- 可能还有 `License`、`Build-Date`、`Packager`、`Base` 等字段缺失

表现：

```text
Section: unknown
Installed-Size: 0
Maintainer: Unknown
```

应从 `.PKGINFO` 中读取并映射：

- `pkgbase` 或 base 信息
- `pkgdesc` -> `Description`
- `packager` -> `Maintainer`
- `size` -> `Installed-Size`，注意单位换算
- `url` -> `Homepage`
- `arch` -> Debian 架构映射
- `depend`、`conflict`、`provides`
- `license`、`builddate` 等可保存到 pacman-debian 自有数据库

相关位置：

- `src/core/pkgfile.ts`
- `src/ops/install.ts`
- `src/db/dpkg-compat.ts`

### P0-2 dpkg 锁的持有范围不覆盖完整事务

状态：已修复。多包安装/删除现在在确认后持锁覆盖整个系统修改阶段，单包入口仍保留重入锁保护。

当前安装流程在下载、预检查完成后，单个包进入 `installPkgFile()` 时才获取 dpkg 锁。多包安装时，每个包分别获取和释放一次锁。

这会产生窗口：

1. pacman 已经完成确认和下载
2. pacman 开始逐包安装
3. 中途释放锁
4. apt 获得锁并开始自己的事务
5. pacman 后续包再次尝试获取锁并失败

用户看到的结果是：一次 pacman 事务在中途失败，而不是在事务开始前明确失败。

应改为：

- 在确认后、任何系统修改前获取一次 dpkg 锁
- 持锁覆盖整个安装事务，包括所有包的解包、脚本、dpkg 状态更新
- 完成全部包后再释放锁
- 下载和纯仓库缓存操作不必持有 dpkg 锁
- 锁失败时，在事务开始前退出，不进入部分安装状态

相关位置：

- `src/ops/install.ts`
- `src/lock/dpkg-lock.ts`
- `src/lock/dpkg-helper.c`

### P0-3 锁 helper 的超时和错误语义需要重新确认

状态：部分修复。锁被占用时 helper 现在报告明确的占用错误；权限、启动失败和异常终止仍需要并发测试覆盖。

当前锁调用默认 `timeout = 0`，但实际错误信息显示：

```text
error: Cannot acquire dpkg frontend lock: Connection timed out
```

需要明确区分：

- 锁当前被占用
- helper 自身连接/通信超时
- helper 启动失败
- 锁文件不存在或权限不足
- dpkg/apt 已经持有锁

不能把所有情况都报告为同一个 `Connection timed out`。用户需要知道是应该等待、终止另一个包管理器，还是修复权限/安装问题。

还应增加并发测试：

- apt 持锁，pacman 启动
- pacman 持锁，apt 启动
- 两个 pacman 进程同时启动
- 锁获取后进程被 SIGTERM/SIGKILL
- 多包事务中途触发第二个包管理器

## P1: 高优先级可靠性问题

### P1-1 依赖解析没有遵循目标包的仓库优先级

状态：已修复。`repo/pkg` 目标会把仓库上下文传递给依赖解析，依赖和虚拟 Provides 会优先从该仓库查找，再回退到全局仓库顺序。

当前依赖解析使用全局首个匹配：

```ts
findInRepo(name)
```

当用户安装：

```bash
pacman -S extra/foo
```

期望行为应是：

1. 先在 `extra` 仓库查找 `foo` 的依赖
2. 依赖包优先在 `extra` 查找
3. `extra` 找不到时，按 `pacman.conf` 中的仓库顺序查找
4. 每个依赖继续继承合适的仓库优先级上下文

当前目标包虽然支持 `repo/pkg` 精确选择，但依赖解析没有携带 repo context，可能从更早的 `trixie` 或其他仓库选出同名包。

需要设计：

- `resolveDeps(targets, { preferredRepos })`
- 目标包名称到 repo 的上下文映射
- 依赖搜索顺序：目标 repo -> 全局 repo 顺序
- 多个目标包来自不同仓库时的独立上下文
- 依赖已被另一个目标解决时的仓库冲突处理
- 明确记录最终选择的 repo

相关位置：

- `src/core/deps.ts`
- `src/ops/install.ts`
- `src/repo/repository.ts`

### P1-2 安装事务不是原子事务，缺少中断恢复

状态：部分修复。单包安装现在显示真实解包进度；仓库下载使用 `.part` 临时文件，下载中断不会留下可被误用的正式缓存文件。完整事务回滚仍未实现。

当前流程可能按以下顺序修改系统：

1. 执行安装脚本
2. 解包并覆盖文件
3. 执行 post-install
4. 写入 pacman-debian 数据库
5. 写入 dpkg status

任一步骤失败，都可能留下半安装状态。已有 transaction JSON 记录，但没有真正的 rollback 或 recovery 流程。

需要增加：

- 事务阶段状态
- 被覆盖文件的备份或临时 staging
- 文件操作日志
- 失败回滚
- 启动时检测未完成事务
- `--recover` 或等价恢复命令
- 部分成功时准确返回非零退出码

相关位置：

- `src/db/database.ts`
- `src/ops/install.ts`
- `src/ops/remove.ts`

### P1-3 文件冲突、符号链接和路径安全需要系统化处理

状态：部分修复。安装路径拒绝 `..` 穿越、包外 symlink 和已有包外父级 symlink；删除时避免删除由其他本地包登记的文件。完整的包间文件冲突预检查和所有权迁移仍未完成。

`.deb` 解包有基本路径越界保护，但安装包管理器还需要处理：

- 包内 `../` 路径
- 包内 symlink 指向包外路径
- 已存在文件与目录冲突
- 已存在路径是 symlink
- 父目录是 symlink
- 两个包拥有同一文件
- `noextract`、`noUpgrade` 与 symlink 的组合
- 删除包时不应误删其他包接管的文件

Arch 包安装路径写入逻辑尤其需要统一安全策略，不能只依赖 `path.resolve()`。

相关位置：

- `src/core/tar.ts`
- `src/ops/install.ts`
- `src/ops/remove.ts`

### P1-4 包签名和仓库信任模型不完整

当前主要依赖 HTTPS、Release/Packages 哈希以及包元数据中的 sha256。尚未完整实现：

- Debian `InRelease`/`Release.gpg` 的 GPG 验证
- Arch 数据库签名验证
- Arch 包签名验证
- keyring 管理
- `SigLevel` 的完整语义

需要在配置中明确区分：

- `Never`
- `Optional`
- `Required`
- 数据库签名
- 包签名

在没有签名验证时，应给出清晰警告，而不是让用户误以为拥有原生 pacman 的信任保证。

### P1-5 部分失败和退出码不够可靠

状态：未完成。本轮仅补充了部分安装错误输出；多包部分成功、脚本失败和命令级退出码仍需统一。

项目中仍存在较多吞掉异常或直接返回成功的路径：

- `catch {}`
- 安装某个包失败后继续处理后续包
- 脚本失败时只返回 `false`，上层可能没有统一汇总
- 空间检查或文件删除失败时错误信息不足
- `print`、锁失败、下载失败的退出码需要统一

需要定义明确的事务结果：

- 全部成功 -> 0
- 用户取消 -> pacman 兼容的取消码
- 部分成功 -> 非零
- 锁失败 -> 非零
- 校验失败 -> 非零
- 脚本失败 -> 非零

## P1: dpkg 兼容层问题

### P1-6 Arch 元数据写入 dpkg status 存在信息损失和语义风险

Arch 包被写入 `/var/lib/dpkg/status` 可以提高 Debian 工具可见性，但两套包模型并不等价。

风险包括：

- Arch 依赖名映射成 Debian 依赖名时丢失语义
- `provides`、`conflicts`、版本约束不完全兼容
- `.so` 依赖可能被丢弃
- 错误架构被改写为系统架构，可能掩盖真实错误
- apt 可能认为依赖已满足，但 ABI 或文件并不匹配
- dpkg 的 conffile、triggers、essential、Multi-Arch 等字段未完整同步

建议保留独立的来源信息：

- 来源仓库
- 原始 repoType
- 原始架构
- 原始 `.PKGINFO` 字段
- 转换后的 dpkg 字段

不要只依靠 dpkg status 作为 pacman-debian 的唯一事实来源。

### P1-7 conffile、trigger 和维护脚本生命周期不完整

需要进一步覆盖 Debian 包生命周期：

- `conffiles` 处理和用户修改检测
- `.dpkg-old`、`.dpkg-dist` 语义
- triggers
- `Pre-Depends`
- `Breaks`、`Replaces`
- upgrade/abort-upgrade 参数
- maintainer script 失败后的恢复流程

当前脚本执行更接近“直接执行脚本”，还不是完整 dpkg 生命周期。

## P2: libalpm 兼容性问题

### P2-1 libalpm 是查询兼容子集，不是完整事务实现

状态：部分修复。未实现事务 API 现在返回 `ALPM_ERR_UNSUPPORTED`，不再伪装成功；真实事务仍未实现。

当前部分 API 是空实现或桩函数，但返回成功：

- `alpm_trans_init`
- `alpm_trans_prepare`
- `alpm_trans_commit`
- `alpm_trans_release`
- `alpm_add_pkg`
- `alpm_remove_pkg`
- 多数 option setter/getter

例如 `alpm_trans_commit()` 当前直接返回 `0`。这会导致调用者误以为事务已经成功提交。

建议：

1. 未实现功能返回明确的 unsupported 错误
2. 不要对未执行的事务返回成功
3. 实现 local/sync 查询 API 的完整状态
4. 为 yay、expac、pactree 建立真实兼容性测试
5. 再逐步实现 staging transaction

相关位置：

- `lib/pac4deb/src/libalpm.c`
- `lib/pac4deb/src/stubs_manual.c`

### P2-2 自定义 JSON 解析器兼容性有限

libalpm 当前使用自定义 JSON scanner，转义字符、Unicode、嵌套结构和数组支持有限。普通包名可以工作，但描述、字段扩展或特殊字符可能解析错误。

建议：

- 限定 JSONL schema 并严格验证
- 改进字符串 escape 解码
- 为 Unicode、引号、反斜杠、嵌套字段增加 fixture
- 避免把任意 JSON 当作已验证的包对象

### P2-3 libalpm 忽略 root、dbpath 和完整配置语义

`alpm_initialize()` 当前忽略 `root`，并大量使用固定路径：

```c
#define DB_DIR "/var/lib/pacman-debian"
```

这会影响：

- chroot
- 容器
- fakeroot
- 自定义 dbpath
- 多实例测试
- 构建环境隔离

## P2: makepkg 和 Arch 工具链问题

### P2-4 makepkg 是常用功能子集，不是完整实现

当前支持常见 PKGBUILD，但仍有边界：

- 复杂 Bash 语法和动态变量
- `pkgver()`、VCS 版本流程
- source 下载和 `::filename::url`
- `arch`、`options`、`backup`、`noextract` 等字段
- 签名校验和签名生成
- build isolation
- 多依赖一次性事务
- `rmdeps` 误删用户原有依赖

特别是 `syncdeps` 逐个安装依赖并在失败时 fallback 到 apt，会混合两套包系统的依赖语义。

相关位置：

- `src/makepkg/build.ts`
- `src/makepkg/pkgbuild.ts`

### P2-5 Arch 兼容工具的覆盖范围和实现语义需要测试矩阵

当前已有：

- `paclink`
- `pactree`
- `makepkg`
- `archlinux-java`
- `fix_default`
- `update-ca-trust`
- `append_path`

但需要分别验证：

- Arch 包安装脚本是否能找到所有工具
- Java 多版本切换和删除
- CA trust 更新后的实际证书链
- paclink 的虚拟包、反向映射和删除行为
- pactree 对 provides、版本依赖和循环依赖的输出
- yay 的 clone、构建、安装、升级、清理依赖全流程

### P2-6 yay 的 AUR 已安装状态与 pacman-debian 本地状态不一致

状态：已修复主要状态源冲突。libalpm 现在以 `by-name` 指向的版本为当前版本，忽略旧版本目录，并且不再把同名 dpkg 条目重复追加到本地包缓存；安装升级时也会清理旧 local DB 目录。

另：`expac` 的格式参数必须放在搜索词之前，例如 `expac -Ss '%r/%n %v' fastfetch`。`expac -Ss fastfetch` 会把 `fastfetch` 当成格式字符串并搜索全部同步包，表现为极慢或输出数量异常。

已观察到以下现象：

```text
$ yay -S linuxqq
Sync Explicit (1): linuxqq-3.2.30-50828
错误：未找到 'linuxqq'
error: 'linuxqq' is not installed

$ yay -Ss linuxqq
aur/linuxqq ... (已安装: 3.2.30-50828)
```

也就是说：

- `yay -Ss` 能通过 AUR 元数据或 libalpm 查询显示 `linuxqq` 的已安装版本
- `yay -S linuxqq` 进入 pacman-debian 后却无法按同一个包名找到可安装目标或本地状态
- 随后某个清理、删除或状态检查路径又报告 `linuxqq` 未安装

这说明以下状态源之间可能没有统一：

- yay/AUR 自己的包信息
- libalpm local DB 查询结果
- `/var/lib/pacman-debian/local/` 中的 `desc`
- `/var/lib/dpkg/status`
- pacman-debian 的仓库包查找逻辑

需要建立完整测试链路：

1. 从 AUR 构建并安装一个包
2. `pacman -Q linuxqq` 能查询到它
3. `pacman -Qi linuxqq` 能读取正确版本和来源
4. `yay -Ss linuxqq` 显示正确已安装版本
5. `yay -S linuxqq` 能正确判断是升级、重装还是目标不存在
6. `yay -R linuxqq` 能正确删除
7. `yay -Syu` 能正确升级该 AUR 包

需要重点检查：

- yay 传给 pacman 的实际参数和操作顺序
- AUR 包名、`pkgbase`、输出文件名之间的映射
- `libalpm` 返回的 local package cache 是否包含正确包
- `alpm_pkg_get_reason()` 与本地 `reason` 是否一致
- `alpm_db_get_pkg()`、`alpm_db_get_pkgcache()` 与 pacman-debian `localdb` 是否读取同一份状态
- AUR 包安装后是否完整写入 `desc`、`files`、`by-name` 和 dpkg 兼容状态
- `-S` 的目标查找失败是否错误地触发了“未安装”路径

在这个问题解决前，不能认为 yay 的 AUR 安装、重装、升级和删除流程已经完全兼容。

## P2: 仓库和缓存一致性

### P2-7 仓库同步缺少原子替换和 repo 级并发保护

状态：部分修复。JSONL chunk、索引和 `.info` 现在通过临时文件原子替换，下载仍缺少 repo 级并发锁和 generation marker。

JSONL、`packages.idx` 和元数据可能在同步中途处于不一致状态。进程被杀死或多个同步进程并发运行时，可能出现：

- idx 指向不存在的 JSONL 偏移
- JSONL 已替换但 idx 仍是旧版本
- 空文件或截断文件被当作有效缓存
- 多个进程同时重建相同仓库

建议使用：

- 临时目录下载
- 完整校验后原子 rename
- generation marker
- repo 级锁
- 启动时清理残留临时文件

### P2-8 `rootDir`、`dbPath`、`cacheDir` 没有完全贯穿所有路径

代码中仍有多处固定路径：

- `/var/lib/pacman-debian`
- `/var/cache/pacman-debian`
- `/var/lib/dpkg`
- `/var/lib/dpkg/info`

这会导致 `--root`、测试 rootfs、chroot 和容器场景无法真正隔离。

## P3: 工程和验证不足

### P3-1 缺少自动化测试体系

当前没有完整的测试目录和 test script。需要建立：

- 版本比较单元测试
- control/PKGINFO 解析测试
- `.deb` 和 `.pkg.tar.zst` fixture
- repo index fixture
- provides/conflicts/OR 依赖测试
- 多仓库优先级测试
- dpkg lock 并发测试
- 安装失败和中断恢复测试
- symlink/path traversal 安全测试
- libalpm ABI smoke test
- makepkg fixture 测试

测试应使用临时 root、临时数据库和临时缓存，不能依赖宿主机当前状态。

### P3-2 文档中的能力边界需要更加明确

文档目前已经列出 Arch ARM glibc 和复杂 AUR 依赖限制，但还应明确：

- 签名验证覆盖范围
- libalpm 哪些 API 是真实实现、哪些是桩
- apt 与 pacman-debian 并行使用的规则
- dpkg status 转换的限制
- 中断事务恢复方式
- 多仓库同名包的选择规则
- `repo/pkg` 对目标包和依赖包的作用范围

## 建议的实施顺序

1. 修复 Arch `.PKGINFO` 到 dpkg 元数据的完整映射
2. 把 dpkg 锁提升到整个安装/删除事务范围
3. 实现目标仓库优先的依赖解析
4. 增加文件冲突和 symlink 安全检查
5. 建立临时 rootfs 的安装、升级、删除测试
6. 修复部分失败和退出码语义
7. 加入 transaction recovery
8. 把 libalpm 空桩改为明确 unsupported，再逐步补全
9. 完善签名验证和 keyring
10. 最后扩展 makepkg 和 yay 的高级兼容性
