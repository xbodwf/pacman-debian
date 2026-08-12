# 架构

## 源文件结构

```
src/
├── cli/
│   ├── pacman.ts            # CLI 参数解析和分发
│   ├── paclink.ts           # 虚拟包链接管理
│   ├── update-ca-trust.ts   # Arch 兼容 CA 证书更新器
│   ├── archlinux-java.ts    # Arch 兼容 Java 环境管理器
│   └── fix_default.ts       # Arch 兼容默认 JDK 助手
├── core/                    # 包格式解析器、依赖引擎
│   ├── ar.ts                # ar 归档解析器
│   ├── tar.ts               # tar 提取器
│   ├── deb.ts               # .deb 包解析器
│   ├── pkgfile.ts           # .pkg.tar.zst 解析器
│   ├── compress.ts          # gz/xz 解压缩
│   ├── control.ts           # Debian control 文件解析器
│   └── deps.ts              # 依赖解析引擎
├── db/
│   ├── localdb.ts           # 目录式本地包数据库
│   ├── database.ts          # 带事务的 DB 封装
│   └── dpkg-compat.ts       # dpkg 状态文件读写
├── ops/
│   ├── install.ts           # 包安装
│   ├── remove.ts            # 包删除
│   ├── query.ts             # 所有 -Q 查询
│   └── upgrade.ts           # 同步 + 升级流程
├── repo/
│   ├── repository.ts        # 仓库同步、下载、JSONL 缓存
│   └── config.ts            # pacman.conf 解析器（支持 Include）
├── scripts/
│   └── setup.ts             # 交互式安装脚本
├── makepkg/
│   ├── index.ts             # makepkg 主入口
│   ├── pkgbuild.ts          # PKGBUILD 解析器
│   ├── source.ts            # 源码下载/解压
│   ├── build.ts             # build()/package() 执行
│   └── printsrcinfo.ts      # .SRCINFO 生成
├── ui/                      # 用户界面（提示、进度、配色）
│   ├── progress.ts          # 官方 pacman 进度条（下载/事务）
│   ├── colors.ts            # pacman 配色（title/version/repo/groups）
│   ├── format.ts            # humanize_size、列宽辅助
│   └── prompt.ts            # 确认提示（本地化）
└── index.ts                 # 入口
```

```
lib/pac4deb/                 # libalpm C 库
├── Makefile                 # 用 gcc 构建，目标 libalpm.so
├── include/
│   ├── alpm.h               # 公共 libalpm API 头文件
│   └── alpm_list.h          # 链表头文件
└── src/
    ├── libalpm.c            # 核心实现（handle、db、pkg、JSON 解析器）
    ├── stubs_manual.c       # ~200 个不常用函数的桩实现
    └── alpm_list.c          # 链表实现
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
│   ├── desc          # JSON 元数据（名称、版本、依赖、groups、大小等）
│   └── files         # 文件清单
└── ...
```

`desc` 元数据会保存从 Arch `.PKGINFO`/`pkgfile` 解析出的 `%GROUP%` 条目，
使 `-Qs`/`-Qi` 能像官方 pacman 一样显示包所属组。

### dpkg 兼容

通过 `dpkg` 或 `apt` 安装的包在查询时直接从 `/var/lib/dpkg/status` 读取
（按 mtime 缓存）。`pacman-debian` 安装包时会同时写入 dpkg 兼容的条目。

### 仓库缓存：`/var/cache/pacman-debian/packages/`

每个仓库以 JSON Lines 块形式缓存（每个 `.jsonl` 文件 5000 个包）。
同步时还会生成全局排序的 `packages.idx` 索引。

```
/var/cache/pacman-debian/packages/
├── bookworm/
│   ├── 00000.jsonl   # JSON Lines, ~5000 包/块
│   ├── ...
│   └── packages.idx  # 全局排序索引 (~200KB)
└── ...
```

#### 内存索引缓存

`packages.idx` 在首次读取后驻留内存，按仓库名 + mtime 缓存：

```
_idxCache = new Map<string, IdxEntry>();
IdxEntry { lines: string[], mtime: number, providesIndex: Map<string, Array<{chunkFile, offset}>> }
```

- 后续操作直接读内存，不重复读盘
- `providesIndex` 是倒排索引，O(1) 查找
- `pacman -Syy` 清空缓存
- 增量同步后自动重新加载

### 查找路径

| 操作 | 方法 | 说明 |
|------|------|------|
| `-S <pkg>` / `-Qo` | 二分搜索 `packages.idx` → seek JSONL | O(log N) |
| `-Ss` | 逐行扫索引（包名+描述）→ seek JSONL | 不解析 JSON |
| `-Sl` | 扫索引 → seek 每个包 | 懒加载 |
| `-Qs` | `localdb.getAllPackages()` 内存 Map + 过滤 | 单次扫描，`indentprint` 折行 |
| `-Qm` | `batchFindInRepo()` 批量对比全部已安装 | 单次批量仓库读取 |
| 依赖 provides | 扫索引 provides 字段 | 仅索引 |
| `-Qi` / `-Ql` | dpkg 状态或本地数据库 | 不涉及缓存 |

## 依赖引擎

依赖解析器（`src/core/deps.ts`）支持：

- 带版本约束的包名解析（`>=`、`<=`、`=`）
- OR 依赖（`|`）
- 架构限定符（如 `:arm64`）
- Debian（逗号分隔）和 Arch（空格分隔）两种格式
- BFS 解析，带预加载 DB 状态
- 冲突检测
- 系统包保护（glibc、libc6 等）

### 性能优化

| 技术 | 说明 |
|------|------|
| **idx 内存缓存** | 二分搜索直接在内存中进行 |
| **provides 倒排索引** | `Map.get()` O(1) 查找 |
| **顺序 BFS + 指针游标** | 避免数组塌缩 |
| **keep-alive HTTP** | 复用 TCP/TLS 连接 |
| **异步解压 .gz** | 不阻塞事件循环 |
| **304 条件请求** | 跳过未变更仓库 |

### 删除时的依赖处理

| 操作 | 逻辑 |
|------|------|
| `-R` | 仅删除指定包 |
| `-Rs` | 删除包 + 递归查找孤儿，逆拓扑序 |
| `-Rc` | 级联：找出所有依赖目标包的包 |
| `-Rsc` | 递归 + 级联组合 |
| `-Rn` | 备份 conffiles 后删除 |

## 仓库支持

- **Debian/Ubuntu**：读取 `Packages.gz` / `Packages.xz`
- **Arch Linux**：读取 `db.tar.gz`，下载 `.pkg.tar.zst` 解包安装
- **Arch ARM**：使用 Arch 二进制仓库可能遇到 glibc 问题——如果你使用 Arch 源，
  遇到 glibc 问题请自行承担后果。可改用 `makepkg` 本地编译。

## 项目状态

主要功能：

- **性能**：`packages.idx` 索引实现亚秒级查找
- **并行同步**：多仓库并发下载
- **多语言**：中英文完整本地化
- **颜色输出**：匹配官方 pacman 配色
- **权限分离**：查询无需 root
- **链接系统**（`paclink`）：Debian→Arch 虚拟包名映射
- **官方进度输出**：`fillProgress`/`renderTransProgress` 对齐上游 pacman 的
  下载条与事务条（`(n/n) 动词 [###---] 100%`）。安装动词按 `verCmp` 与已装
  版本对比显示 `正在安装 / 正在更新 / 正在降级 / 正在重装`。
- **`.pacnew` / `.pacsave` 提示**：无法合并的配置文件以 `.pacnew` 形式写出，
  并在该包进度行结束后提示，与 pacman 一致。
- **本地版本更新警告**：`-Syu` 时对本地版本高于仓库的包输出
  （`警告：<pkg>：本地 (<v1>) 比 <repo> 的版本更新 (<v2>)`）并跳过降级。
- **外来包查询**（`-Qm` / `-Qmq`）：列出所有已安装但不在任何已同步仓库中的包，
  静默模式仅输出包名，便于脚本使用。
- **标准输入目标列表**：`-S -` 和 `-U -` 从标准输入逐行读取目标，支持管道如
  `comm -23 <(pacman -Qq) <(pacman -Qmq) | sudo pacman -S -`。

主要限制：

- **Arch 二进制仓库**：如果你使用 Arch 源并遇到 glibc 问题，请自行承担后果。
- **yay/AUR**：复杂 AUR 依赖链可能因包名差异失败
