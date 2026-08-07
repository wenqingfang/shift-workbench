import os, base64, json, ssl, urllib.request, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
TOKEN = open(os.path.join(ROOT, ".deploy_token")).read().strip()
REPO = "wenqingfang/shift-workbench"

# 本次更新这四个文件
FILES = [
    ("index.html", False),
    ("styles.css", False),
    ("app.js", False),
    ("sw.js", False),
]

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def put(path, is_bin):
    full = os.path.join(ROOT, path)
    with open(full, "rb") as f:
        raw = f.read()
    b64 = base64.b64encode(raw).decode()
    url = f"https://api.github.com/repos/{REPO}/contents/{urllib.parse.quote(path)}"
    # 先取当前文件的 sha，否则 PUT 会 422
    try:
        req0 = urllib.request.Request(url, method="GET")
        req0.add_header("Authorization", f"Bearer {TOKEN}")
        req0.add_header("Accept", "application/vnd.github+json")
        with urllib.request.urlopen(req0, context=ctx, timeout=30) as r:
            sha = json.load(r).get("sha")
    except Exception as e:
        print(f"GET {path} failed: {e}")
        return False
    body = json.dumps({
        "message": f"feat: 天气提醒 + 2026节假日 + 退出锁屏通知",
        "content": b64,
        "sha": sha,
        "branch": "main",
    }).encode()
    req = urllib.request.Request(url, data=body, method="PUT")
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
            d = json.load(r)
            print(f"OK   {path:8} -> {d.get('content',{}).get('html_url','')}")
            return True
    except urllib.error.HTTPError as e:
        print(f"FAIL {path}: {e.code} {e.read().decode()[:300]}")
        return False

if __name__ == "__main__":
    ok = 0
    for p, b in FILES:
        if put(p, b):
            ok += 1
    print(f"\n=== {ok}/{len(FILES)} 文件已更新 ===")
