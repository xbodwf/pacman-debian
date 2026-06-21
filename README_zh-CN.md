# pacman-debian

一个采用 Arch Linux pacman 命令行语法的包管理器，直接操作 Debian/Ubuntu `.deb`
包。它在 dpkg 层面管理包（绕过 APT），同时也支持原生 Arch Linux `.pkg.tar.zst`
包（通过内置 libalpm 兼容 yay 实现 AUR 支持）。

## 目标

- 在基于 Debian 的系统上提供一致的 pacman 风格 CLI，消除 `apt`、`dpkg` 及
  各种前端之间的切换成本。
- 在单一工具下支持多仓库混合配置（Debian/Ubuntu + Arch Linux 仓库）。
- 与 dpkg 数据库（`/var/lib/dpkg/status`）完全兼容，可与 APT 及其他 dpkg
  前端共存。
- 提供 libalpm ABI 兼容的共享库，使基于 Go 的 AUR 助手（yay）无需修改即可
  在 Debian 上运行。

## 环境要求

- Node.js 18+（TypeScript，通过 `tsc` 编译）
- pnpm 包管理器
- Debian 12 Bookworm（或兼容的 Debian 发行版）
- 安装、删除和升级操作需要 root 权限
- 编译工具：`gcc`、`make`、`ldconfig`

## 快速开始

```bash
# 编译 TypeScript + C 库
pnpm install && pnpm build

# 运行交互式安装（创建配置、符号链接、dpkg 条目）
sudo node dist/scripts/setup.js

# 或手动设置：
sudo ln -sf "$PWD/dist/cli/pacman.js" /usr/local/bin/pacman

# 同步仓库
sudo pacman -Sy

# 搜索包
pacman -Ss neofetch

# 安装
sudo pacman -S neofetch

# 升级所有包
sudo pacman -Syu

# 删除
sudo pacman -R neofetch
```

## 配置

配置文件：`/etc/pacman-debian/pacman.conf`

配置使用纯 Arch Linux pacman 语法，支持 `Include` 指令。仓库特有键
（`Type`、`Dist`、`Components` 等）放在 `/etc/pacman.d/` 的包含文件中。

配置示例：

```ini
[options]
Architecture = auto

[bookworm]
Include = /etc/pacman.d/debian-bookworm

[extra]
Include = /etc/pacman.d/arch-extra
```

包含文件示例（`/etc/pacman.d/debian-bookworm`）：

```
Server = https://mirrors.tuna.tsinghua.edu.cn/debian
Type = debian
Dist = bookworm
Components = main contrib non-free non-free-firmware
```

Arch 仓库的包含文件（`/etc/pacman.d/arch-extra`）：

```
Server = http://mirror.archlinuxarm.org/$arch/$repo
Type = arch
Architecture = auto
```

安装时会创建 `/etc/pacman.conf` → `/etc/pacman-debian/pacman.conf` 符号链接，
以便硬编码该路径的工具（如 yay）正常工作。

使用 `pacman-conf` 查看解析后的配置（所有 `Include` 文件已展开，
`$repo`/`$arch` 变量已替换）：

```bash
$ pacman-conf
# pacman-debian configuration
[options]
Architecture = auto

[bookworm]
Server = https://mirrors.tuna.tsinghua.edu.cn/debian
Type = debian
Dist = bookworm
Components = main contrib non-free non-free-firmware

[extra]
Server = http://mirror.archlinuxarm.org/$arch/$repo
Type = arch
Architecture = auto
```

## 数据库

### 本地数据库：`/var/lib/pacman-debian/local/`

采用与 Arch Linux 本地 DB 一致的目录-包格式：

```
/var/lib/pacman-debian/local/
├── index.json       # 包名 → 目录映射（base64 编码路径）
├── by-name/
│   ├── fastfetch -> ../fastfetch-2.64.2-2/
│   └── ...
├── fastfetch-2.64.2-2/
│   ├── desc          # JSON 元数据（名称、版本、依赖、大小等）
│   └── files         # 文件清单
└── ...
```

`index.json` 以 `name:base64path` 格式逐行记录包名到目录的映射，是删除和查询
的首选查找路径。若文件缺失或损坏会自动从文件系统重建。

### dpkg 兼容

通过 `dpkg` 或 `apt` 安装的包在查询时直接从 `/var/lib/dpkg/status` 读取
（按 mtime 缓存）。`pacman-debian` 安装包时会同时写入 dpkg 兼容的条目，
确保 `apt` 和 `dpkg` 仍能识别该包。

### 仓库缓存：`/var/cache/pacman-debian/packages/`

每个仓库以 JSON Lines 块形式缓存（每个 `.jsonl` 文件 5000 个包）。
同步时还会生成全局排序的 `packages.idx` 索引，格式：
`包名 描述\tprovides\t分块文件\t字节偏移`

```
/var/cache/pacman-debian/packages/
├── bookworm/
│   ├── 00000.jsonl   # JSON Lines, ~5000 包/块
│   ├── ...
│   ├── packages.idx  # 全局排序索引 (~200KB)
│   └── .info         # 元数据（总数、块数）
└── ...
```

#### 内存索引缓存

`packages.idx` 在首次读取后驻留内存，按仓库名 + mtime 缓存：

```
_idxCache = new Map<string, IdxEntry>();
IdxEntry { lines: string[], mtime: number, providesIndex: Map<string, Array<{chunkFile, offset}>> }
```

- 后续 `-S`/`-Ss`/`-Sl` 操作直接读内存，不重复读盘
- `providesIndex` 是倒排索引：`provides 名 → [{ chunkFile, offset }]`
  - `findProvider()` 查 provides 时 O(1) `Map.get()`，无需扫文件
- `pacman -Syy` 清空缓存（调用 `invalidateIdxCache()`）
- 增量同步后 idx 文件 mtime 变化，自动重新加载

#### 查找路径

| 操作 | 磁盘方法 | 首次后方法 |
|------|----------|-----------|
| `-S <pkg>` / `-Qo` | 二分搜索 `packages.idx` → seek JSONL | 二分搜索内存 `lines[]` → seek JSONL |
| `-Ss` | 逐行扫 `packages.idx`（包名+描述）→ seek JSONL | 扫内存 `lines[]`，不解析 JSON |
| `-Sl` | 扫 `packages.idx` → seek 每个包 | 扫内存 `lines[]`，懒加载 |
| 依赖 provides | 扫 `packages.idx` provides 字段 | 内存 `providesIndex.get()`，O(1) |
| `-Qi` / `-Ql` | dpkg 状态或本地数据库 | 不涉及缓存 |

## 仓库支持

- **Debian/Ubuntu**：从标准仓库索引读取 `Packages.gz` / `Packages.xz`。
  支持 `Server` URL 中的 `$repo`/`$arch` 变量替换。
- **Arch Linux**：从 Arch 兼容仓库读取 `db.tar.gz`。下载的 `.pkg.tar.zst`
  文件会被解包并安装。
- **Arch ARM**：二进制包需要 glibc 2.38+ — Debian 12 自带 glibc 2.36，
  因此在 Bookworm 上 Arch ARM 二进制仓库**无法使用**（升级 glibc 会损坏系统）。
  请改用 `makepkg` 进行本地编译。

## libalpm（libpac4deb）

位于 `lib/pac4deb/` 的 C 库，实现了 libalpm ABI（`alpm.h`），使基于 Go 的
AUR 助手（如 yay）无需修改即可在 Debian 上运行。它读取：

- 本地数据库（`/var/lib/pacman-debian/local/`）— pacman-debian 安装的包
- dpkg 状态（`/var/lib/dpkg/status`）— apt/dpkg 的系统包
- 同步数据库（`/var/cache/pacman-debian/packages/*/` — JSONL 块）

提供了 200+ 个不常用函数的桩实现。

关键实现细节：

- **packages.idx 二分查找（C）**：`alpm_db_get_pkg` 和 `alpm_find_dbs_satisfier`
  对排序索引做二分查找，然后按字节偏移读取单行 JSONL——不加载全部 JSONL。
- **自动注册 sync DB**：`ensure_syncdbs` 在首次调用 `alpm_get_syncdbs` 时扫描
  `/var/cache/pacman-debian/packages/`，懒加载注册所有可用仓库。
- **包 DB 指针**：`pkg_internal.db` 字段记录所属数据库；`alpm_pkg_get_db` 返回它，
  防止 `DB().Name()` 空指针崩溃。
- **基于 idx 的搜索**：`alpm_db_search` 扫描索引行做模式匹配，而非加载全部包。
  6 仓库/15000 包的情况下 `-Ss` 约 1.5 秒。
- **dpkg Provides 解析**：`load_dpkg_status` 读取 dpkg status 的 `Provides:` 字段，
  使声明了虚拟包名的 Debian 包（如 `7zip` → `p7zip`）能被 yay 通过 `alpm_pkg_has_provide` 发现。
- **本地 DB 后备搜索**：`alpm_find_dbs_satisfier` 在 sync DB 搜索失败后搜索本地数据库
  （通过 `alpm_find_satisfier`），同时匹配包名和 provides——
  使 yay 能通过 `libgnutls30t64` 的映射 provides 找到 `gnutls`。
- **find_in_idx provides 扫描**：包名二分查找失败后扫描 `packages.idx` 的 provides 列，
  匹配 sync DB 中的虚拟提供（如 Arch 仓库中 `libz.so` → `zlib`）。
- **dpkg -S 后备**：对于找不到的 `lib*.so` SONAME，通过 `dpkg -S` 在运行时查归属。
- **Debian alternatives**：加载本地 DB 时检测 `/etc/alternatives/` 中的
  `sh`、`awk`、`vi`、`editor` 等，自动为归属包添加虚拟 provides。

## makepkg（`src/makepkg/`）

独立的 `makepkg` 实现，无需 `base-devel` 或任何 Arch 工具即可从 PKGBUILD
构建 Arch Linux 包。

```bash
# 从 PKGBUILD 构建包
cd /path/to/PKGBUILD/dir
makepkg --syncdeps --install
```

功能：

- 通过 bash sourcing（`source PKGBUILD`）解析 PKGBUILD — 支持所有标准变量
  （`pkgname`、`pkgver`、`source`、`depends`、`makedepends`、
  `sha256sums` 等）
- 下载并验证源文件（支持 http/https URL，带校验和验证）
- 解压归档：`.tar.gz`、`.tar.xz`、`.tar.bz2`、`.tar.zst`、`.zip`
- 在干净的环境中运行 `prepare()`、`build()`、`check()` 和 `package()` 函数
- 创建带有有效 `.PKGINFO` 元数据的 `.pkg.tar.zst` 归档
- 通过 `--syncdeps` 进行依赖解析 — 通过 pacman-debian 的同步数据库
  （Debian 和 Arch 仓库）安装缺失依赖
- 支持 `--install`（`-i`）、`--clean`（`-c`）、`--rmdeps`

| 参数 | 说明 |
|------|------|
| `-s, --syncdeps` | 通过 pacman 安装缺失依赖 |
| `-i, --install` | 安装构建好的包 |
| `-c, --clean` | 打包后清理构建文件 |
| `-r, --rmdeps` | 构建后删除已安装的依赖 |
| `-f, --force` | 覆盖已有的包文件 |
| `-o, --nobuild` | 仅下载和解压源码（不构建） |
| `--nocolor` | 禁用彩色输出 |
| `--printsrcinfo` | 打印 `.SRCINFO` 并退出 |

## 命令

### 同步（-S）

| 命令 | 说明 |
|------|------|
| `pacman -S <pkg>` | 从仓库安装包 |
| `pacman -Sy` | 刷新包数据库（mtime 检查，24 小时） |
| `pacman -Syy` | 强制刷新包数据库（清除内存 idx 缓存） |
| `pacman -Su` | 升级所有已安装的包 |
| `pacman -Syu` | 刷新数据库并升级 |
| `pacman -Ss <keyword>` | 搜索仓库 |
| `pacman -Si <pkg>` | 显示远程包信息 |
| `pacman -Sl` | 列出仓库中所有包 |
| `pacman -Sw <pkg>` | 真正下载 .deb/.pkg.tar.zst 到缓存目录，不安装 |
| `pacman -Sc` | 删除缓存目录中的 .deb/.pkg.tar.zst 文件，保留仓库元数据 |
| `pacman -Scc` | 清空整个缓存目录（含仓库 jsonl/idx，需重新 -Sy） |
| `pacman -Sp <pkg>` | 打印实际下载 URL（不会安装） |

### 删除（-R）

| 命令 | 说明 |
|------|------|
| `pacman -R <pkg>` | 删除包 |
| `pacman -Rs <pkg>` | 删除包及未使用的依赖 |
| `pacman -Rn <pkg>` | 删除包及其配置文件 |
| `pacman -Rns <pkg>` | 删除包、依赖和配置文件 |
| `pacman -Rc <pkg>` | 级联删除：删除依赖该包的所有包 |
| `pacman -Rdd <pkg>` | 跳过依赖检查强制删除 |
| `pacman -Rp <pkg>` | 打印将要删除的内容（干运行） |

支持多目标（`pacman -R a b`）：所有目标合并显示后统一确认。

### 查询（-Q）

| 命令 | 说明 |
|------|------|
| `pacman -Q` | 列出所有已安装的包 |
| `pacman -Qe` | 列出显式安装的包 |
| `pacman -Qd` | 列出作为依赖安装的包 |
| `pacman -Qdt` | 列出孤儿包（未使用的依赖） |
| `pacman -Qi <pkg>` | 显示详细包信息 |
| `pacman -Ql <pkg>` | 列出包拥有的文件 |
| `pacman -Qo <file>` | 查询文件属于哪个包 |
| `pacman -Qs <keyword>` | 搜索已安装的包 |
| `pacman -Qk [pkg]` | 验证已安装包的文件完整性（检查文件是否存在且非空） |
| `pacman -Qq` | 静默模式：仅输出包名，不带版本号 |

### 其他

| 命令 | 说明 |
|------|------|
| `pacman -U <file>` | 安装本地包文件（.deb/.pkg.tar.zst） |
| `pacman -U <url>` | 从 http/https/ftp URL 下载后安装，装完自动清理 |
| `pacman -D --asdeps <pkg>` | 将包标记为依赖 |
| `pacman -D --asexplicit <pkg>` | 将包标记为显式安装 |
| `pacman -T <pkg>` | 检查依赖是否满足 |
| `pacman -F <file>` | 搜索提供该文件的包 |
| `pacman -V` | 显示版本号 |

### 内置工具

| 命令 | 说明 |
|------|------|
| `pacman-conf` | 打印解析后的配置（类似 Arch 的 `pacman-conf`）。查看每个仓库的 Server URL、Type、Dist、Components。 |
| `makepkg` | 从 PKGBUILD 文件构建 Arch Linux 包。支持 `--syncdeps`、`--install`、`--clean`、源码下载和 `.pkg.tar.zst` 创建。 |
| `pacman-debian-setup` | 交互式安装：创建配置、Include 文件、符号链接（`/etc/pacman.conf`、`/usr/local/bin/pacman`）和虚拟 `pacman` dpkg 条目。 |
| `paclink` | 管理持久化的 Debian→Arch 虚拟包名映射。链接存储在本地数据库中，仅对 pacman/libalpm 可见，dpkg 不可见。 |

### paclink（链接管理）

| 命令 | 说明 |
|------|------|
| `paclink -Ln <deb> <virt>` | 创建链接：Debian 包 `<deb>` 提供 Arch 虚拟名 `<virt>` |
| `paclink -L` | 列出所有链接 |
| `paclink -Ls <关键词>` | 搜索链接 |
| `paclink -Li <虚拟名>` | 显示链接详情 |
| `paclink -R <虚拟名>` | 删除链接（不影响 Debian 包） |

示例：

```bash
# 映射 dash 提供 sh
sudo paclink -Ln dash sh

# 映射 python3 提供 python
sudo paclink -Ln python3 python

# 列出所有映射
paclink -L

# 搜索含 python 的链接
paclink -Ls python
```

链接以 `repoType: link` 存储在本地 DB。当某仓库中存在与链接同名的真包时，
真包优先，安装时自动移除链接。

### 全局参数

| 参数 | 说明 |
|------|------|
| `--noconfirm` | 跳过确认提示 |
| `--confirm` | 始终询问确认（默认） |
| `--needed` | 不重新安装已是最新的包 |
| `--noscriptlet` | 不执行安装脚本 |
| `--print` | 干运行：显示将要执行的操作但不实际执行 |

### 配置选项

| 选项 | 说明 |
|------|------|
| `Color` | 启用彩色输出（放在 `[options]` 段） |
| `Architecture` | 设置目标架构（默认 `auto`） |
| `IgnorePkg` | 跳过指定包的升级 |

## 依赖引擎

依赖解析器（`src/core/deps.ts`）支持：

- 带版本约束的包名解析（`>=`、`<=`、`=`）
- OR 依赖（`|`）
- 架构限定符（如 `:arm64`、`:amd64`）
- Debian（逗号分隔）和 Arch（空格分隔）两种格式
- BFS 解析，带预加载 DB 状态
- 已安装和待安装包之间的冲突检测
- 系统包保护（glibc、libc6 等）
- `upgradeMode`：升级时依赖基准为"已安装版本"，而非"仓库最新版本"

- **文件验证**：已安装的包如果磁盘上没有真实文件（只剩空目录），视为未安装，
  强制重新下载。
- **显式目标始终处理依赖**：即使目标已安装，也会遍历其依赖检查缺失项。
- **队列出队**：依赖队列用 `shift()` 弹出已处理项，防止内存堆积。

### 性能优化

| 技术 | 说明 |
|------|------|
| **idx 内存缓存** | `findInRepo()` 二分搜索直接在 `_idxCache` 的 `lines[]` 上进行，无需读文件（`src/repo/repository.ts:58`） |
| **provides 倒排索引** | `providesIndex` 在 idx 加载时构建，`findProvider()` 直接 `Map.get()`，O(1) 定位（`src/repo/repository.ts:69`） |
| **顺序 BFS + 指针游标** | 依赖队列用索引指针替代 `shift()`，避免数组塌缩开销（`src/core/deps.ts:74`） |
| **已解析集合去重** | `resolved` 用 `Set<string>` 去重，避免重复解析相同依赖（`src/core/deps.ts:73`） |
| **批量头尾双扫** | `batchFindInRepo()` 利用排序 idx 从首尾同时二分查找，适合升级候选收集（`src/repo/repository.ts`） |
| **keep-alive HTTP** | 共享 `https.Agent({ keepAlive: true, maxSockets: 8 })`，复用 TCP/TLS 连接（`src/repo/repository.ts:22`） |
| **异步解压 .gz** | `decompressAsync()` 用 `zlib.gunzip()` 回调版，不阻塞事件循环（`src/core/compress.ts:9`） |
| **304 条件请求** | 同步时发 `If-Modified-Since`，服务端返回 304 直接跳过（`src/repo/repository.ts:96`） |

### 删除时的依赖处理（`src/ops/remove.ts`）

| 操作 | 逻辑 |
|------|------|
| `-R` | 仅删除指定包，不处理依赖 |
| `-Rs` | 删除包 + 递归查找孤儿（不被其他包 RequiredBy 的包），按逆拓扑序删除 |
| `-Rc` | 级联：找出所有"需要"目标包的包，一并删除 |
| `-Rsc` | 递归 + 级联组合 |
| `-Rn` | 备份 `/var/lib/dpkg/info/<pkg>.conffiles` 中的配置文件为 `.dpkg-old`，再删除 |

删除时自动排序：被依赖者先删（叶子节点先于根节点），确保依赖检查不报错。
`isRequiredByOthers()` 遍历所有已安装包的 `Depends` 字段，判断目标包是否被需要。

## 架构

```
src/
├── cli/
│   ├── pacman.ts       # CLI 参数解析和分发
│   └── paclink.ts      # 虚拟包链接管理
├── core/               # 包格式解析器、依赖引擎
│   ├── ar.ts           # ar 归档解析器
│   ├── tar.ts          # tar 提取器
│   ├── deb.ts          # .deb 包解析器
│   ├── pkgfile.ts      # .pkg.tar.zst 解析器
│   ├── compress.ts     # gz/xz 解压缩
│   ├── control.ts      # Debian control 文件解析器
│   └── deps.ts         # 依赖解析引擎
├── db/
│   ├── localdb.ts      # 目录式本地包数据库
│   ├── database.ts     # 带事务的 DB 封装
│   └── dpkg-compat.ts  # dpkg 状态文件读写
├── ops/
│   ├── install.ts      # 包安装
│   ├── remove.ts       # 包删除
│   ├── query.ts        # 所有 -Q 查询
│   └── upgrade.ts      # 同步 + 升级流程
├── repo/
│   ├── repository.ts   # 仓库同步、下载、JSONL 缓存
│   └── config.ts       # pacman.conf 解析器（支持 Include）
├── scripts/
│   └── setup.ts        # 交互式安装脚本
├── makepkg/
│   ├── index.ts        # makepkg 主入口
│   ├── pkgbuild.ts     # PKGBUILD 解析器
│   ├── source.ts       # 源码下载/解压
│   ├── build.ts        # build()/package() 执行
│   └── printsrcinfo.ts # .SRCINFO 生成
├── ui/                 # 用户界面（提示、格式化）
└── index.ts            # 入口
```

## libalpm C 库

```
lib/pac4deb/
├── Makefile            # 用 gcc 构建，目标 libalpm.so
├── include/
│   ├── alpm.h          # 公共 libalpm API 头文件
│   └── alpm_list.h     # 链表头文件
└── src/
    ├── libalpm.c       # 核心实现（handle、db、pkg、JSON 解析器）
    ├── stubs_manual.c  # ~200 个不常用 libalpm 函数的桩实现
    └── alpm_list.c     # 链表实现
```

构建：`make -C lib/pac4deb`
安装：`sudo make -C lib/pac4deb install`

## yay / AUR 支持

通过内置 libalpm，`yay` 可与 `pacman-debian` 配合使用：

```bash
# 安装 yay（需要 Go）
sudo apt install golang-go
git clone https://aur.archlinux.org/yay.git /tmp/yay
cd /tmp/yay && go build -o /usr/local/bin/yay

# 与 pacman-debian 配合使用
PACMAN=/usr/local/bin/pacman yay -Ss ponysay
PACMAN=/usr/local/bin/pacman sudo -E yay -S ponysay
```

注意：依赖 `python`（而非 `python3`）的 AUR 包在 Debian 12 上无法解析，
因为系统包名是 `python3`。安装 `python-is-python3` 或创建符号链接可解决。

## 构建

```bash
pnpm install
pnpm build                # tsc + C 库
# 或分步执行：
pnpm exec tsc
make -C lib/pac4deb       # 构建 libalpm.so
```

## 项目状态

该项目在 v7.1.0 时更名为 `pacman-debian`。目前在 Debian 12 上
可用于日常包管理。已有功能：

- **依赖解析**：顺序 BFS + idx 内存缓存 + provides 倒排索引，亚秒级
  依赖查找。删除时正确处理孤儿级联和 conffile 备份。
- **性能优化**：`packages.idx` 索引实现亚秒级单包查找。`-Ss` 只扫索引
  （不解析 JSON）。全量 `-Sl` 通过索引 seek。HTTP keep-alive agent
  复用 TCP 连接，异步 zlib 解压不阻塞事件循环。
- **并行同步**：多仓库并发下载，每仓库独立进度行。HTTP 条件请求（304）
  跳过未变更仓库。Debian 组件串行但多仓库并行。
- **真正的下载能力**：`-Sw` 已能实际下载包文件，`-Sp` 打印真实 URL，
  `-U` 支持 http/https/ftp/file URL 自动下载后安装。
- **选择性缓存清理**：`-Sc` 只删包缓存保留元数据，`-Scc` 清空全部。
- **多语言**：通过 `$LANG` 自动切换中英文。同步、安装、升级流程均已
  本地化。消息目录在 `src/i18n/`。
- **颜色输出**：遵守 `pacman.conf` 的 `Color` 选项。颜色方案匹配官方
  pacman（品红=仓库、绿=包名、红=错误）。
- **权限分离**：查询命令（`-Q`、`-Ss`、`-Si`、`-Sp`、`-Rp`）无需 root。
  写操作需要 `sudo`。
- **链接系统**（`paclink`）：Debian→Arch 虚拟包名映射以本地 DB 条目存储
  （`repoType: link`）。仓库真包自动优先于链接，安装时覆盖。
  链接仅对 pacman/libalpm 可见，dpkg 不可见。
- **作用域 i18n**：每个工具（pacman、paclink、setup）首次使用时才加载自己的
  翻译文件，减少冷启动开销。语言：en、zh-CN。

主要限制：

- **Arch ARM 二进制仓库需要 glibc 2.38+** — Debian 12 自带 2.36。
  本地 `makepkg` 构建可正常使用。
- **yay/AUR**：libalpm 桩库支持包搜索和依赖解析，但复杂 AUR 依赖链
  可能因 Debian/Arch 包名差异而失败。
- **AUR 助手集成**仅测试了 yay（paru、pamac 等未测试）。

## 许可证

GNU General Public License v3.0
