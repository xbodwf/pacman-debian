# makepkg

独立的 `makepkg` 实现，无需 `base-devel` 或任何 Arch 工具即可从 PKGBUILD
构建 Arch Linux 包。

```bash
# 从 PKGBUILD 构建包
cd /path/to/PKGBUILD/dir
makepkg --syncdeps --install
```

## 功能

- 通过 bash sourcing 解析 PKGBUILD
- 下载并验证源文件
- 解压归档：`.tar.gz`、`.tar.xz`、`.tar.bz2`、`.tar.zst`、`.zip`
- 运行 `prepare()`、`build()`、`check()`、`package()`
- 创建 `.pkg.tar.zst` 归档
- 通过 `--syncdeps` 安装缺失依赖

## 参数

| 参数 | 说明 |
|------|------|
| `-s, --syncdeps` | 通过 pacman 安装缺失依赖 |
| `-i, --install` | 安装构建好的包 |
| `-c, --clean` | 打包后清理构建文件 |
| `-r, --rmdeps` | 构建后删除已安装的依赖 |
| `-f, --force` | 覆盖已有的包文件 |
| `-o, --nobuild` | 仅下载和解压源码 |
| `--nocolor` | 禁用彩色输出 |
| `--printsrcinfo` | 打印 `.SRCINFO` 并退出 |
