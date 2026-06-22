# paclink（包链接管理）

管理持久化的 Debian→Arch 虚拟包名映射。链接存储在本地数据库中，
仅对 pacman/libalpm 可见，dpkg 不可见。

## 命令

| 命令 | 说明 |
|------|------|
| `paclink -Ln <deb> <virt>` | 创建链接：Debian 包 `<deb>` 提供 Arch 虚拟名 `<virt>` |
| `paclink -L` | 列出所有链接 |
| `paclink -Ls <关键词>` | 搜索链接 |
| `paclink -Li <虚拟名>` | 显示链接详情 |
| `paclink -R <虚拟名>` | 删除链接（不影响 Debian 包） |

## 示例

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

## 行为

- 链接以 `repoType: link` 存储在本地 DB
- 当仓库中存在与链接同名的真包时，真包优先，安装时自动移除链接
- 链接仅对 pacman 和 libalpm 可见

## 默认链接

Setup 创建的默认映射：

| 虚拟名 | Debian 包 |
|--------|-----------|
| sh | bash（或 dash） |
| python | python3 |
| zlib | zlib1g |
| bzip2 | libbz2-1.0 |
| xz | liblzma5 |
| zstd | libzstd1 |
| openssl | libssl-dev |
| libssl | libssl3t64 |
| libcrypt | libcrypt1 |
| libffi | libffi8 |
| libpcre | libpcre3 |
| libpcre2 | libpcre2-8-0 |
| libpng | libpng16-16t64 |
| libjpeg-turbo | libjpeg62-turbo |
| freetype2 | libfreetype6 |
| ncurses | libncursesw6 |
| readline | libreadline8t64 |
| sqlite | libsqlite3-0 |
| expat | libexpat1 |
| libxml2 | libxml2 |
| glibc | libc6 |
| gcc-libs | libgcc-s1 |
| libstdc++ | libstdc++6 |
| systemd-libs | libsystemd0 |
| gnutls | libgnutls30t64 |
| libcurl | libcurl4t64 |
| ca-certificates-utils | ca-certificates |
