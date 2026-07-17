# pacman-debian

一个采用 Arch Linux pacman 命令行语法的包管理器，直接操作 Debian/Ubuntu `.deb`
包。它在 dpkg 层面管理包（绕过 APT），同时也支持原生 Arch Linux `.pkg.tar.zst`
包（通过内置 libalpm 兼容 yay 实现 AUR 支持）。

**v7.6.0 亮点：**
- **按操作分类的帮助** — `-S`、`-R`、`-Q`、`-D`、`-T`、`-F`、`-U` 都有独立的本地化
  `--help` 输出
- **更清楚的升级摘要** — 详细升级列表显示仓库、旧/新版本、下载大小和净安装大小变化
- **更完整的升级流程** — `-Syu` 支持 dpkg 独占软件包和显式目标，并统一使用事务处理
- **更安全的包来源接管** — 更换包来源前显示警告，并使用本地化提示确认
- **更可靠的本地数据库查询** — 按软件包名称精确匹配，避免把 `pipewire` 和
  `pipewire-bin` 混淆
- **更接近官方 pacman 的版本输出** — `pacman -V` 和 `pacman pacman` 显示吃豆人图案，版本文本支持本地化

**v7.4.0 亮点：**
- **零 dpkg 依赖** — 版本算法内嵌自 libdpkg，dpkg 状态文件直接解析，不调用
  dpkg 命令
- **字节索引数据库** — 排序 idx + 二分查找 + JSONL 分块存储
- **内存缓存** — idx 文件只加载一次，包数据按偏移量缓存
- **亚百毫秒搜索** — 3000+ 包扫描 + 缓存读取
- **Release 文件同步** — 先下 InRelease/Release，验证 SHA256 再下 Packages
- **XferCommand** — 自定义下载命令（aria2c、curl、wget）
- **Paclink 文件后端** — 映射存储在 `/var/lib/pacman-debian/paclinks`，C 层
  直接读取，无需重编译

## 简介

### 目标

- 在基于 Debian 的系统上提供一致的 pacman 风格 CLI，消除 `apt`、`dpkg` 及
  各种前端之间的切换成本。
- 在单一工具下支持多仓库混合配置（Debian/Ubuntu + Arch Linux 仓库）。
- 与 dpkg 数据库（`/var/lib/dpkg/status`）完全兼容，可与 APT 及其他 dpkg
  前端共存。
- 提供 libalpm ABI 兼容的共享库，使基于 Go 的 AUR 助手（yay）无需修改即可
  在 Debian 上运行。

### 项目状态

可用于基于 Debian 发行版的日常包管理。
详见[项目状态](docs/zh-CN/architecture.md#项目状态)。

## 安装

### 环境要求

- Node.js 18+
- Debian 系发行版（Debian、Ubuntu、Armbian、Linux Mint 等）
- 写操作需要 root 权限
- 编译工具：`gcc`、`make`、`ldconfig`

### 安装

```bash
npm install -g pacman-debian@latest
sudo $(which pacman-debian-setup)
```

> [!WARNING]
> `npm install -g` **必须**在 `sudo` 或 `root` 用户下运行。
> 如果使用普通用户安装，Node.js 会将包安装到用户家目录（`~/.npm-global/` 等），
> 存在被其他用户或脚本篡改、植入恶意内容的风险。请始终使用 `sudo npm install -g`。

安装完成后，运行下面的命令迁移系统 APT 源并开始使用 pacman-debian：

```bash
sudo pacmigrate setup
```

然后同步软件包源，并进行全面系统更新：

```bash
sudo pacman -Sy
sudo pacman -Syu
```

`pacmigrate setup` 同时读取传统的 `sources.list`/`.list` 文件和 Ubuntu 24.04
使用的 deb822 `.sources` 文件。它不会修改 APT 源文件，会先备份现有的
pacman-debian 配置，并询问常用的 pacman 选项。

Arch 到 Debian 的兼容映射需要单独同步：

```bash
sudo paclink -Syu
```

`paclink` 将映射文件作为自己的仓库：`-Sy` 同步源，`-Su` 使用缓存源，`-U`
安装本地映射文件。只有 Debian 目标包已安装时才会创建映射。目标包被删除后，
对应映射也会删除；如果仍有已安装的 Arch 包依赖该虚拟名称，会显示警告。

### 开发安装

```bash
git clone https://github.com/xbodwf/pacman-debian.git
cd pacman-debian
pnpm install && pnpm build
sudo node dist/scripts/setup.js
```

详见[安装说明](docs/zh-CN/installation.md)。

## 快速上手

```bash
# 搜索
pacman -Ss neofetch

# 安装
sudo pacman -S neofetch

# 删除
sudo pacman -R neofetch

# 升级所有
sudo pacman -Syu

# 查询已安装
pacman -Q
```

完整命令参考见[使用文档](docs/zh-CN/usage.md)。

## 文档

| 主题 | 中文 | English |
|------|------|---------|
| 使用（完整命令参考） | [docs/zh-CN/usage.md](docs/zh-CN/usage.md) | [docs/en/usage.md](docs/en/usage.md) |
| 配置 | [docs/zh-CN/configuration.md](docs/zh-CN/configuration.md) | [docs/en/configuration.md](docs/en/configuration.md) |
| 架构与数据库 | [docs/zh-CN/architecture.md](docs/zh-CN/architecture.md) | [docs/en/architecture.md](docs/en/architecture.md) |
| makepkg | [docs/zh-CN/makepkg.md](docs/zh-CN/makepkg.md) | [docs/en/makepkg.md](docs/en/makepkg.md) |
| libalpm & yay/AUR | [docs/zh-CN/yay-aur.md](docs/zh-CN/yay-aur.md) | [docs/en/yay-aur.md](docs/en/yay-aur.md) |
| paclink（包链接） | [docs/zh-CN/paclink.md](docs/zh-CN/paclink.md) | [docs/en/paclink.md](docs/en/paclink.md) |
| 安装说明（详细） | [docs/zh-CN/installation.md](docs/zh-CN/installation.md) | [docs/en/installation.md](docs/en/installation.md) |

## 许可证

GNU General Public License v3.0
