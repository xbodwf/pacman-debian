# pactree — 包依赖树查看器

显示包的依赖树（正向：依赖了什么，反向：被什么依赖）。查询所有可用来源：
本地数据库、dpkg 状态和仓库索引。

## 用法

```
pactree [选项] <包名>
```

## 选项

| 选项 | 说明 |
|------|------|
| `-r`, `--reverse` | 显示反向依赖（谁依赖这个包） |
| `-d`, `--depth` | 最大树深度（默认不限） |
| `-s`, `--sync` | 显示版本号 |
| `-h`, `--help` | 显示帮助 |

## 示例

```bash
# 查看 glibc 依赖了什么
pactree glibc

# 查看谁依赖 glibc（反向）
pactree -r glibc

# 限制深度为 2
pactree -d 2 python3

# 显示版本
pactree -s mesa
```

## 说明

- 循环依赖会被检测并标记 `(circular)`
- 找不到的包标记 `(not found)`
- 查询范围包括 dpkg 状态、pacman-debian 本地数据库和同步仓库
