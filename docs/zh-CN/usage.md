# 使用文档

## 同步（-S）

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
| `pacman -Sw <pkg>` | 下载包到缓存目录，不安装 |
| `pacman -Sc` | 删除缓存目录中的包文件，保留仓库元数据 |
| `pacman -Scc` | 清空整个缓存目录（含仓库 jsonl/idx） |
| `pacman -Sp <pkg>` | 打印下载 URL（不会安装） |

## 删除（-R）

| 命令 | 说明 |
|------|------|
| `pacman -R <pkg>` | 删除包 |
| `pacman -Rs <pkg>` | 删除包及未使用的依赖 |
| `pacman -Rn <pkg>` | 删除包及其配置文件 |
| `pacman -Rns <pkg>` | 删除包、依赖和配置文件 |
| `pacman -Rc <pkg>` | 级联删除：删除依赖该包的所有包 |
| `pacman -Rdd <pkg>` | 跳过依赖检查强制删除 |
| `pacman -Rp <pkg>` | 显示将要删除的内容（干运行） |

支持多目标（`pacman -R a b`）：所有目标合并显示后统一确认。

## 查询（-Q）

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
| `pacman -Qk [pkg]` | 验证包文件完整性 |
| `pacman -Qq` | 静默模式：仅输出包名 |

## 其他

| 命令 | 说明 |
|------|------|
| `pacman -U <file>` | 安装本地包文件（.deb/.pkg.tar.zst） |
| `pacman -D --asdeps <pkg>` | 将包标记为依赖 |
| `pacman -D --asexplicit <pkg>` | 将包标记为显式安装 |
| `pacman -T <pkg>` | 检查依赖是否满足 |
| `pacman -F <file>` | 搜索提供该文件的包 |
| `pacman -V` | 显示版本号 |

## 内置工具

| 命令 | 说明 |
|------|------|
| `pacman-conf` | 打印解析后的配置 |
| `makepkg` | 从 PKGBUILD 构建 Arch 包（见 [makepkg](makepkg.md)） |
| `pacman-debian-setup` | 交互式安装脚本 |
| `paclink` | 管理 Debian→Arch 虚拟包名映射（见 [paclink](paclink.md)） |
| `update-ca-trust` | CA 证书更新器（Arch 兼容，包装 `update-ca-certificates`） |
| `archlinux-java` | Java 环境管理器：`status`、`get`、`set`、`unset`、`fix` |
| `fix_default` | 打印当前默认 JDK 短名（Arch Java 包安装脚本使用） |

## 全局参数

| 参数 | 说明 |
|------|------|
| `--noconfirm` | 跳过确认提示 |
| `--confirm` | 始终询问确认（默认） |
| `--needed` | 不重新安装已是最新的包 |
| `--noscriptlet` | 不执行安装脚本 |
| `--print` | 干运行 |

## 配置选项（`pacman.conf [options]`）

| 选项 | 说明 |
|------|------|
| `Color` | 启用彩色输出 |
| `Architecture` | 设置目标架构（默认 `auto`） |
| `IgnorePkg` | 跳过指定包的升级 |

详见[配置文档](configuration.md)。
