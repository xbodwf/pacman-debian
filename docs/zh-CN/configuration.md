# 配置

配置文件：`/etc/pacman-debian/pacman.conf`

使用纯 Arch Linux pacman 语法，支持 `Include` 指令。仓库特有键
（`Type`、`Dist`、`Components` 等）放在 `/etc/pacman.d/` 的包含文件中。

## 示例

```ini
[options]
Architecture = auto

[bookworm]
Include = /etc/pacman.d/debian-bookworm

[extra]
Include = /etc/pacman.d/arch-extra
```

包含文件 `/etc/pacman.d/debian-bookworm`：

```
Server = https://mirrors.tuna.tsinghua.edu.cn/debian
Type = debian
Dist = bookworm
Components = main contrib non-free non-free-firmware
```

Arch 仓库包含文件 `/etc/pacman.d/arch-extra`：

```
Server = http://mirror.archlinuxarm.org/$arch/$repo
Type = arch
Architecture = auto
```

## 仓库类型

### Debian

| 键 | 必需 | 说明 |
|-----|------|------|
| `Server` | 是 | 镜像 URL（支持 `$repo`、`$arch` 变量替换） |
| `Type` | 是 | 必须为 `debian` |
| `Dist` | 是 | 发行版代号（如 `bookworm`、`trixie`） |
| `Components` | 是 | 空格分隔的组件列表（`main contrib non-free`） |

### Arch

| 键 | 必需 | 说明 |
|-----|------|------|
| `Server` | 是 | 镜像 URL（支持 `$repo`、`$arch` 变量替换） |
| `Type` | 是 | 必须为 `arch` |
| `Architecture` | 否 | 设为 `auto` 以匹配系统架构 |

## 符号链接

安装时会创建 `/etc/pacman.conf` → `/etc/pacman-debian/pacman.conf` 符号链接，
方便硬编码该路径的工具（如 yay）使用。

## 查看解析后的配置

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
