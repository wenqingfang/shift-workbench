#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
部署脚本：把班次闹钟工作台推到 Gitee Pages。
- 从 .gitee_token 读取私人令牌（长期复用，不询问用户）
- 自动取用户名、创建仓库（已存在则跳过）、上传全部静态文件
- 开启 Gitee Pages 并触发首次构建
用法：python deploy_gitee.py
"""
import base64
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN_FILE = os.path.join(HERE, ".gitee_token")
REPO = "shift-workbench"
BRANCH = "master"

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def api(method, path, body=None, is_json=True):
    url = f"https://gitee.com/api/v5{path}"
    params = f"?access_token={TOKEN}"
    data = None
    headers = {"User-Agent": "wb-deploy", "Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url + params, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=40) as r:
            raw = r.read().decode("utf-8", "ignore")
            return r.status, (json.loads(raw) if (is_json and raw) else raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "ignore")
        try:
            msg = json.loads(raw).get("message", raw)
        except Exception:
            msg = raw
        return e.code, msg


def main():
    global TOKEN, LOGIN
    if not os.path.exists(TOKEN_FILE):
        print("❌ 找不到 .gitee_token，无法部署"); sys.exit(1)
    TOKEN = open(TOKEN_FILE, encoding="utf-8").read().strip()

    # 1) 取用户名
    st, me = api("GET", "/user")
    if st != 200 or not isinstance(me, dict) or "login" not in me:
        print("❌ 令牌无效或无法获取用户信息：", me); sys.exit(1)
    LOGIN = me["login"]
    print("✅ 已登录 Gitee：", LOGIN, me.get("name", ""))

    # 2) 创建仓库（已存在则忽略）
    st, res = api("POST", "/user/repos", {
        "name": REPO, "private": False,
        "description": "班次闹钟工作台 PWA（Gitee Pages）", "auto_init": False,
    })
    if st == 201:
        print("✅ 仓库已创建：", res.get("full_name"))
    elif st == 409 or (isinstance(res, str) and "已经存在" in res):
        print("ℹ️ 仓库已存在，跳过创建")
    elif st == 400 and isinstance(res, str) and "已存在" in res:
        print("ℹ️ 仓库已存在，跳过创建")
    else:
        print("⚠️ 创建仓库返回：", st, res)

    # 3) 上传文件（存在则更新）
    files = [
        "index.html", "styles.css", "app.js", "sw.js",
        "manifest.webmanifest", "icon.svg",
        "icon-192.png", "icon-512.png", ".nojekyll",
    ]
    for f in files:
        p = os.path.join(HERE, f)
        if not os.path.exists(p):
            print("⚠️ 跳过缺失文件：", f); continue
        with open(p, "rb") as fh:
            raw = fh.read()
        is_text = f.endswith((".html", ".css", ".js", ".webmanifest", ".nojekyll"))
        if is_text:
            content = base64.b64encode(raw).decode("ascii")
        else:
            content = base64.b64encode(raw).decode("ascii")
        # 先查是否已有 sha
        st0, exist = api("GET", f"/repos/{LOGIN}/{REPO}/contents/{f}")
        sha = exist.get("sha") if isinstance(exist, dict) else None
        body = {"content": content, "branch": BRANCH,
                "message": "deploy: update " + f}
        if sha:
            body["sha"] = sha
            m, r = api("PUT", f"/repos/{LOGIN}/{REPO}/contents/{f}", body)
        else:
            m, r = api("POST", f"/repos/{LOGIN}/{REPO}/contents/{f}", body)
        ok = m in (200, 201)
        print(("✅" if ok else "❌"), f, "->", m, ("" if ok else r))

    # 4) 开启 Pages / 触发重建
    st, pg = api("POST", f"/repos/{LOGIN}/{REPO}/pages",
                 {"branch": BRANCH, "path": "/"})
    if st == 200 and isinstance(pg, dict) and pg.get("https_url"):
        url = pg["https_url"]
        print("✅ Gitee Pages 已开启：", url)
    else:
        # 可能已开启 -> 用 PUT 重建
        st2, pg2 = api("PUT", f"/repos/{LOGIN}/{REPO}/pages",
                       {"branch": BRANCH, "path": "/"})
        if st2 == 200 and isinstance(pg2, dict) and pg2.get("https_url"):
            print("✅ Gitee Pages 已重建：", pg2["https_url"])
        else:
            print("⚠️ 开启 Pages 返回：", st, pg)
            if isinstance(pg, str) and ("实名" in pg or "认证" in pg):
                print("💡 Gitee Pages 需要实名认证：去 gitee.com → 设置 → 实名认证 后再部署")
            print("   手动开启：仓库页 → 服务 → Gitee Pages → 部署分支选 master、目录 / → 启动")

    print("\n📌 站点地址应为：https://%s.gitee.io/%s/" % (LOGIN, REPO))


if __name__ == "__main__":
    main()
