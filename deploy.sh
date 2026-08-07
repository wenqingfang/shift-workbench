#!/usr/bin/env bash
# 部署脚本：用 .deploy_token 里的 GitHub PAT 建仓库、推送、开 Pages
# token 通过 curl --oauth2-bearer @file 读取，不进命令历史；脚本结束后删除文件并移除 remote
set -e
TOKENFILE=".deploy_token"
REPO_NAME="shift-workbench"
API="https://api.github.com"
CURL="curl --ssl-no-revoke -sS"

echo "==> 1) 读取登录名"
$CURL --oauth2-bearer @$TOKENFILE -H "Accept: application/vnd.github+json" "$API/user" -o /tmp/gh_user.json -w "user_http=%{http_code}\n"
LOGIN=$(grep -o '"login":"[^"]*"' /tmp/gh_user.json | head -1 | sed 's/"login":"//; s/"$//')
echo "登录名: $LOGIN"

echo "==> 2) 创建仓库（已存在则忽略）"
$CURL --oauth2-bearer @$TOKENFILE -H "Accept: application/vnd.github+json" -X POST "$API/user/repos" \
  -d "{\"name\":\"$REPO_NAME\",\"private\":false,\"description\":\"班次闹钟工作台 PWA\"}" \
  -o /tmp/gh_create.json -w "create_http=%{http_code}\n" || true

echo "==> 3) 推送代码"
TOKEN=$(cat "$TOKENFILE")
git remote remove origin 2>/dev/null || true
git remote add origin "https://$TOKEN@github.com/$LOGIN/$REPO_NAME.git"
git push -u origin main

echo "==> 4) 开启 GitHub Pages"
$CURL --oauth2-bearer @$TOKENFILE -H "Accept: application/vnd.github+json" -X POST "$API/repos/$LOGIN/$REPO_NAME/pages" \
  -d '{"source":{"branch":"main","path":"/"},"build_type":"legacy"}' \
  -o /tmp/gh_pages.json -w "pages_http=%{http_code}\n" || true

echo "==> 5) 获取网址（Pages 构建需 1~2 分钟）"
sleep 3
$CURL --oauth2-bearer @$TOKENFILE "$API/repos/$LOGIN/$REPO_NAME/pages" -o /tmp/gh_pages2.json -w "get_http=%{http_code}\n" || true
echo "你的工作台网址："
grep -o '"html_url":"[^"]*"' /tmp/gh_pages2.json | head -1 | sed 's/"html_url":"//; s/"$//'

echo "==> 6) 清理 token 文件与 remote"
git remote remove origin 2>/dev/null || true
echo "完成。请到 GitHub → Settings → Developer settings → Personal access tokens 吊销本次 token。"
