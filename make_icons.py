"""无依赖生成 PWA 图标 PNG（渐变毛玻璃风格时钟）"""
import zlib, struct, math

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def make(size, path):
    px = [[(11, 13, 26) for _ in range(size)] for _ in range(size)]
    r = size * 0.22          # 圆角
    c1, c2, c3 = (124, 92, 255), (194, 92, 255), (34, 211, 238)

    def inside_round_rect(x, y):
        if r <= x <= size - r or r <= y <= size - r:
            return 0 <= x < size and 0 <= y < size
        cx = r if x < r else size - r
        cy = r if y < r else size - r
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

    cx = cy = size / 2
    ring_r = size * 0.30
    ring_w = size * 0.038
    hand_w = size * 0.036

    for y in range(size):
        for x in range(size):
            if not inside_round_rect(x + .5, y + .5):
                continue
            t = (x / size * .55 + y / size * .45)
            base = lerp(c1, c2, t / .5) if t < .5 else lerp(c2, c3, (t - .5) / .5)

            # 内层玻璃面板
            pad_x = size * 0.19
            pad_y = size * 0.22
            if pad_x <= x <= size - pad_x and pad_y <= y <= size - pad_y * 0.78:
                base = lerp(base, (255, 255, 255), 0.20 - 0.10 * (y / size))

            d = math.hypot(x - cx, y - cy)
            # 表盘圆环
            if abs(d - ring_r) <= ring_w / 2:
                base = (255, 255, 255)
            # 指针（12点方向 + 4点方向）
            elif d < ring_r - ring_w:
                if abs(x - cx) <= hand_w / 2 and cy - ring_r * 0.72 <= y <= cy:
                    base = (255, 255, 255)
                else:
                    dx, dy = x - cx, y - cy
                    L = ring_r * 0.62
                    ux, uy = 0.82, 0.57
                    proj = dx * ux + dy * uy
                    if 0 <= proj <= L:
                        perp = abs(dx * (-uy) + dy * ux)
                        if perp <= hand_w / 2:
                            base = (255, 255, 255)
            px[y][x] = base

    raw = b''.join(b'\x00' + bytes(v for p in row for v in p) for row in px)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    open(path, 'wb').write(png)
    print('wrote', path, size)

make(192, 'icon-192.png')
make(512, 'icon-512.png')
