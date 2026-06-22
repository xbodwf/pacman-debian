# libalpm & yay / AUR 支持

## libalpm C 库（libpac4deb）

位于 `lib/pac4deb/` 的 C 库，实现了 libalpm ABI（`alpm.h`），使基于 Go 的
AUR 助手（如 yay）无需修改即可在 Debian 上运行。它读取：

- 本地数据库（`/var/lib/pacman-debian/local/`）
- dpkg 状态（`/var/lib/dpkg/status`）
- 同步数据库（`/var/cache/pacman-debian/packages/*/`）

提供了 200+ 个不常用函数的桩实现。

### 关键实现细节

- **二分查找**：对排序索引做二分查找，按字节偏移读单行 JSONL
- **自动注册 sync DB**：首次调用时扫描缓存目录，懒加载注册
- **dpkg Provides 解析**：读取 dpkg status 的 `Provides:` 字段
- **本地 DB 后备搜索**：sync DB 搜索失败后搜索本地数据库
- **dpkg -S 后备**：`lib*.so` SONAME 找不到时通过 `dpkg -S` 查归属
- **Debian alternatives**：检测 `/etc/alternatives/` 自动添加虚拟 provides

### 构建

```bash
make -C lib/pac4deb
sudo make -C lib/pac4deb install
```

## yay / AUR 支持

```bash
# 安装 yay（需要 Go）
sudo apt install golang-go
git clone https://aur.archlinux.org/yay.git /tmp/yay
cd /tmp/yay && go build -o /usr/local/bin/yay

# 与 pacman-debian 配合使用（PACMAN 自动识别）
yay -Ss ponysay
sudo -E yay -S ponysay
```

注意：依赖 `python`（而非 `python3`）的 AUR 包可通过 setup 创建的 paclink
映射 `python → python3` 自动解析。
