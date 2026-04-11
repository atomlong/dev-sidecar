# Submit Workflow

当用户要求提交代码或执行 `/submit.md` 时，请遵循以下流程。

## 分支说明

| 私有分支 (开发用) | 公共分支 (发布用) |
|------------------|------------------|
| `develop`        | `main`/`master`  |
| `dev/xxx`        | `feature/xxx`    |

私有分支包含所有文件；公共分支仅包含可公开的文件。

还有 `release` 分支（如 `release-v2.1.x`），用于触发 CI，发布软件包。

## 1. 前置检查

```bash
./submit.sh --check-prerequisites
```

检查分支命名和父分支纯净度。失败时参考 `newdev.md` 重建分支。

## 2. 查看变更

| 类型     | 命令                               | 说明         |
|----------|-----------------------------------|--------------|
| 私有文件 | `./submit.sh --print-private-show` | 状态 + diff |
| 公共文件 | `./submit.sh --print-public-show`  | 状态 + diff |

其他选项：`--print-xxx-status`（仅状态）、`--print-xxx-diff`（仅 diff）、`--print-xxx-files`（文件列表）。

## 3. 提交

根据变更生成符合 [Conventional Commits](https://www.conventionalcommits.org/) 规范的消息：

```bash
# 私有变更
export COMMIT_MSG_PRIVATE="feat(memory-bank): update progress"
./submit.sh --commit-private

# 公共变更
export COMMIT_MSG_PUBLIC="fix(biss): correct CRC calculation"
./submit.sh --commit-public
```

## 4. 推送

| 命令                              | 说明                                     |
|----------------------------------|------------------------------------------|
| `./submit.sh --push-private` | 推送私有分支 → 仅私有仓库                  |
| `./submit.sh --push-public`  | 同步公共提交 → 公共分支 → 所有仓库         |

推送时自动检测仓库可见性，跳过不可达或不适用的仓库。

如需覆盖 `--push-public` 的默认冲突策略，可显式设置：

```bash
# 默认等价于 ours，一般无需设置
export SUBMIT_PUBLIC_CONFLICT_STRATEGY=theirs
./submit.sh --push-public
```

默认行为：
- `--push-public` 默认按 `ours` 自动收敛冲突。
- 如果自动解决后发现 cherry-pick 变成空提交，会自动 `git cherry-pick --skip`。

## 5. 同步上游公共仓库

```bash
./submit.sh --sync-upstream
```

说明：
- 当前建议只在 `develop` 上执行。
- 脚本会确保存在 fetch-only 的 `upstream` remote（默认指向 `https://github.com/docmirror/dev-sidecar.git`）。
- 会先抓取上游公共分支，再合并到本地 `master`/`main`，最后再把更新后的公共分支合并回 `develop`。
- **不会自动 push**；完成后请按需要继续执行 `./submit.sh --push-private` 和/或 `./submit.sh --push-public`。

## 6. 发布新版本

当准备发布新版本时（如 `v2.1.0`）：

1. **更新版本**：修改 `package.json` 版本号，并在 `CHANGELOG.md` 添加发布说明。
2. **执行发布**：

```bash
./submit.sh --release
```

此命令会自动：
- 从 `CHANGELOG.md` 读取版本号。
- 创建并推送 Release 分支（如 `release-v2.1.x`）。
- 创建并推送 Git Tag（如 `v2.1.0`）。
- 触发 GitHub Actions 自动构建和发布 Release。

## 7. 网络与代理

脚本不再自动检测或改写 git 代理配置。
如果遇到网络问题（如 `GnuTLS recv error`），请自行配置系统网络环境、环境变量代理，或 git 的 proxy 设置。

## 8. 清理

```bash
unset COMMIT_MSG_PRIVATE COMMIT_MSG_PUBLIC SUBMIT_PUBLIC_CONFLICT_STRATEGY
```

## 9. 报告

向用户报告：
- 当前分支
- 私有/公共提交的 Hash 和 Message
- 远程同步状态
- 异常警告（如需手动解决的冲突）
