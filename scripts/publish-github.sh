#!/usr/bin/env bash
#
# 创建 GitHub 仓库并推送。
#
# 前置条件：
#   1. 公钥已添加到 GitHub 账号（Settings → SSH and GPG keys）
#   2. 仓库名通过第一个参数传入
#
# 用法：bash scripts/publish-github.sh <repo-name> [--private|--public]

set -euo pipefail

REPO_NAME="${1:-}"
VISIBILITY="--private"

if [[ "${2:-}" == "--public" ]]; then
  VISIBILITY="--public"
fi

if [[ -z "$REPO_NAME" ]]; then
  echo "用法：bash scripts/publish-github.sh <repo-name> [--private|--public]" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

echo "→ 校验 SSH 连通性…"
if ! ssh -o ConnectTimeout=15 -T git@github.com 2>&1 | grep -q "successfully authenticated"; then
  echo "✗ SSH 未认证。请先把公钥添加到 GitHub：" >&2
  echo "  cat ~/.ssh/id_ed25519_github.pub" >&2
  exit 1
fi

# 通过 SSH 反查当前认证的 GitHub 用户名
GITHUB_USER=$(ssh -o ConnectTimeout=15 -T git@github.com 2>&1 | sed -n 's/^Hi \([^!]*\)!.*/\1/p')
if [[ -z "$GITHUB_USER" ]]; then
  echo "✗ 无法确定 GitHub 用户名" >&2
  exit 1
fi
echo "→ 当前账号：${GITHUB_USER}"

REMOTE="git@github.com:${GITHUB_USER}/${REPO_NAME}.git"
echo "→ 目标远程：${REMOTE}"

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE"
else
  git remote add origin "$REMOTE"
fi

echo "→ 推送 main 分支…"
git push -u origin main

echo "→ 设置默认推送分支…"
git remote set-head origin -a >/dev/null 2>&1 || true

echo ""
echo "✓ 完成：https://github.com/${GITHUB_USER}/${REPO_NAME}"
