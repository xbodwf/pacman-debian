# 安装说明

## 环境要求

- Node.js 18+
- Debian 系发行版（Debian、Ubuntu、Armbian、Linux Mint 等）
- 写操作需要 root 权限
- 编译工具：`gcc`、`make`、`ldconfig`（可选，用于 libalpm C 库）

## npm 安装（推荐）

```bash
npm install -g pacman-debian@latest
sudo $(which pacman-debian-setup)
```

> [!WARNING]
> `npm install -g` **必须**在 `sudo` 或 `root` 用户下运行。
> 如果使用普通用户安装，Node.js 会将包安装到用户家目录（`~/.npm-global/` 等），
> 存在被其他用户或脚本篡改、植入恶意内容的风险。请始终使用 `sudo npm install -g`。

### Setup 做了什么

1. 创建默认配置 `/etc/pacman-debian/pacman.conf`
2. 创建 `/etc/pacman.conf` → `/etc/pacman-debian/pacman.conf` 符号链接
3. 创建 CLI 符号链接（`pacman`、`makepkg`、`pacman-conf`、`paclink`、`update-ca-trust`、`archlinux-java`、`fix_default`）
4. 创建 `/var/lib/pacman` → `/var/lib/pacman-debian` 符号链接（fastfetch 检测用）
5. 安装 Arch 兼容工具（`update-ca-trust`、`archlinux-java`、`fix_default`）
6. 安装 Arch 兼容 shell 函数（`/etc/profile.d/append_path.sh`）
7. 注册虚拟 `pacman` 包到 dpkg 状态
8. 安装指向独立 `xbodwf/paclinks` 仓库的 paclink 源配置；映射需要另外运行
   `paclink -Sy` 和 `paclink -Syu` 才会启用

## 开发安装

```bash
git clone https://github.com/xbodwf/pacman-debian.git
cd pacman-debian
pnpm install
pnpm build                # tsc + C 库
sudo node dist/scripts/setup.js
```

或手动设置：

```bash
sudo ln -sf "$PWD/dist/cli/pacman.js" /usr/local/bin/pacman
sudo ln -sf "$PWD/dist/cli/paclink.js" /usr/local/bin/paclink
sudo ln -sf "$PWD/dist/scripts/pacman-conf.js" /usr/local/bin/pacman-conf
sudo ln -sf "$PWD/dist/makepkg/index.js" /usr/local/bin/makepkg
```

## 首次使用

```bash
# 同步仓库
sudo pacman -Sy

# 同步并启用 Arch 到 Debian 兼容映射
sudo paclink -Sy
sudo paclink -Syu

# 搜索
pacman -Ss neofetch

# 安装
sudo pacman -S neofetch
```

完整命令参考见[使用文档](usage.md)。
