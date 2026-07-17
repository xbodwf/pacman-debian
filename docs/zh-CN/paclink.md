# paclink（Arch 到 Debian 映射）

`paclink` 为已安装的 Debian 软件包提供 Arch 软件包虚拟名称，使
pacman-debian、libalpm 和 AUR 助手可以解析 Arch 依赖，而实际文件仍由
dpkg 管理。

默认映射源单独维护在
`https://github.com/xbodwf/paclinks`。当前生效映射位于
`/var/lib/pacman-debian/paclinks`；paclink 还会把对应的 `Provides:` 写入
`/var/lib/dpkg/status`。

## 推荐流程

```bash
# 下载独立映射源
sudo paclink -Sy

# 根据已安装 Debian 软件包重建映射
sudo paclink -Syu
```

只有 Debian 目标包已安装时，`-Syu` 才会启用对应映射。目标包被删除后，
对应映射也会删除；如果仍有已安装的 Arch 软件包依赖该虚拟名称，paclink
会显示警告。

`-Su` 只使用缓存源重建映射，`-Syyu` 会强制刷新映射源后再重建。

## 命令

| 命令 | 说明 |
|------|------|
| `paclink -Sy` | 同步映射源 |
| `paclink -Syy` | 强制同步映射源 |
| `paclink -Su` | 根据缓存源重建映射 |
| `paclink -Syu` | 同步并重建映射 |
| `paclink -Syyu` | 强制同步并重建映射 |
| `paclink -U <文件>` | 安装本地映射源文件 |
| `paclink -Q` | 列出当前映射软件包 |
| `paclink -Qi [名称]` | 显示映射软件包信息 |
| `paclink -Ql [名称]` | 列出映射记录 |
| `paclink -Qs <关键词>` | 搜索映射软件包 |
| `paclink -Qo <Debian包>` | 查询 Debian 包对应的 Arch 虚拟名 |
| `paclink -L` | 列出当前链接（兼容视图） |
| `paclink -Ln <Debian包> <虚拟名>` | 创建手工链接 |
| `paclink -R <虚拟名>` | 删除手工或当前链接 |

## 配置

配置文件为 `/etc/pacman-debian/paclink.conf`：

```ini
[options]
Color = auto
CacheDir = /var/cache/pacman-debian
Server = https://raw.githubusercontent.com/xbodwf/paclinks/main/paclinks.conf
```

`CacheDir` 中的缓存文件名为 `paclinks.conf`。独立仓库使用每行一条映射：

```text
python python3
libcurl libcurl4t64
gtk4 libgtk-4-1
```

## 验证

查看当前生效映射：

```bash
sudo paclink -Q
```

查看 paclink 写入 dpkg 的虚拟提供关系：

```bash
dpkg-query -W -f='${Package}: ${Provides}\n' libcairo2 libpango-1.0-0 libgtk-4-1 libpam0g
```

模拟依赖解析但不修改系统：

```bash
sudo apt-get -s --no-remove install appstream
sudo apt-get check
```

`apt remove pacman` 不是映射测试命令。它会主动删除虚拟 `pacman` 包，
并让 APT 重新求解整个混合依赖图，因此会产生大量无关错误。

## 手工链接

本地例外仍可使用手工链接：

```bash
sudo paclink -Ln dash sh
paclink -L
paclink -Ls python
sudo paclink -R sh
```

现在 setup 不再创建完整的默认映射。请使用独立映射源和 `-Syu`，让映射
跟随系统实际安装的 Debian 软件包。
