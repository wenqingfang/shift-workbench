"""把工作台打包成一个自包含的单文件 HTML，可直接拷到手机上离线打开。"""
import base64
import json
import os
import re

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, '班次闹钟.html')


def read(name, mode='r'):
    p = os.path.join(BASE, name)
    if mode == 'rb':
        return open(p, 'rb').read()
    return open(p, encoding='utf-8').read()


html = read('index.html')
css = read('styles.css')
js = read('app.js')
icon192 = base64.b64encode(read('icon-192.png', 'rb')).decode()
icon512 = base64.b64encode(read('icon-512.png', 'rb')).decode()
manifest = json.loads(read('manifest.webmanifest'))

# 图标改为内嵌 data URI
manifest['icons'] = [
    {"src": "data:image/png;base64," + icon192, "sizes": "192x192",
     "type": "image/png", "purpose": "any maskable"},
    {"src": "data:image/png;base64," + icon512, "sizes": "512x512",
     "type": "image/png", "purpose": "any maskable"},
]
manifest['start_url'] = './'
manifest.pop('scope', None)

# 1) 内联 CSS
html = html.replace(
    '<link rel="stylesheet" href="styles.css">',
    '<style>\n' + css + '\n</style>'
)

# 2) 图标 / manifest：改成运行时用 Blob 注入，避免相对路径失效
html = html.replace(
    '<link rel="manifest" href="manifest.webmanifest">',
    ''
)
html = html.replace(
    '<link rel="apple-touch-icon" href="icon.svg">',
    '<link rel="apple-touch-icon" href="data:image/png;base64,' + icon192 + '">'
)

boot = (
    '<script>\n'
    'window.__SINGLE_FILE__ = true;\n'
    '(function(){\n'
    '  try {\n'
    '    var m = ' + json.dumps(manifest, ensure_ascii=False) + ';\n'
    '    var b = new Blob([JSON.stringify(m)], {type:"application/manifest+json"});\n'
    '    var l = document.createElement("link");\n'
    '    l.rel = "manifest";\n'
    '    l.href = URL.createObjectURL(b);\n'
    '    document.head.appendChild(l);\n'
    '  } catch (e) {}\n'
    '})();\n'
    '</script>\n'
)
html = html.replace('</head>', boot + '</head>')

# 3) 内联 JS
html = html.replace(
    '<script src="app.js"></script>',
    '<script>\n' + js + '\n</script>'
)

# 校验没有残留的外部相对引用
leftovers = re.findall(r'(?:src|href)="(?!data:|#|https?:)([^"]+)"', html)
if leftovers:
    raise SystemExit('仍有外部引用未内联: ' + str(leftovers))

open(OUT, 'w', encoding='utf-8').write(html)
print('生成:', OUT)
print('大小: %.1f KB' % (os.path.getsize(OUT) / 1024))
