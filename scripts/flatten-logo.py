#!/usr/bin/env python3
"""
把 logo 图里视觉上是纯色留白的噪点像素拍平成真正的纯色 FDFDFB，
让 PNG 无损压缩真正生效（AI 生成图自带细微噪点，是启动图体积膨胀的元凶）。
不改分辨率、不动 logo 主体色，视觉无差别。

零第三方依赖：用 sips 转 BMP 后以标准库解析，再直接写出 PNG。
用法: python3 flatten-logo.py 输入.png 输出.png
"""
import struct, subprocess, sys, tempfile, zlib, os

BG = (253, 253, 251)  # FDFDFB
TOL = 14              # 各通道与留白色的最大差值，超过则视为 logo 主体保留


def read_bmp(path):
    with open(path, 'rb') as f:
        data = f.read()
    if data[:2] != b'BM':
        raise ValueError('not a BMP file')
    px_off = struct.unpack_from('<I', data, 10)[0]
    w, h = struct.unpack_from('<ii', data, 18)
    bpp = struct.unpack_from('<H', data, 28)[0]
    if bpp not in (24, 32):
        raise ValueError(f'unsupported bpp: {bpp}')
    step = bpp // 8
    row_size = (w * step + 3) & ~3
    top_down = h < 0
    h = abs(h)
    rows = []
    for y in range(h):
        src_y = y if top_down else h - 1 - y
        base = px_off + src_y * row_size
        row = bytearray(w * 3)
        for x in range(w):
            b, g, r = data[base + x * step: base + x * step + 3]
            row[x * 3:x * 3 + 3] = bytes((r, g, b))
        rows.append(row)
    return w, h, rows


def flatten(rows):
    r0, g0, b0 = BG
    for row in rows:
        for i in range(0, len(row), 3):
            if (abs(row[i] - r0) <= TOL and abs(row[i + 1] - g0) <= TOL
                    and abs(row[i + 2] - b0) <= TOL):
                row[i], row[i + 1], row[i + 2] = r0, g0, b0


def write_png(path, w, h, rows):
    raw = b''.join(b'\x00' + bytes(row) for row in rows)
    def chunk(tag, body):
        c = tag + body
        return struct.pack('>I', len(body)) + c + struct.pack('>I', zlib.crc32(c))
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)))
        f.write(chunk(b'IDAT', zlib.compress(raw, 9)))
        f.write(chunk(b'IEND', b''))


def main():
    src, dst = sys.argv[1], sys.argv[2]
    with tempfile.NamedTemporaryFile(suffix='.bmp', delete=False) as tmp:
        bmp = tmp.name
    try:
        subprocess.run(['sips', '-s', 'format', 'bmp', src, '--out', bmp],
                       check=True, capture_output=True)
        w, h, rows = read_bmp(bmp)
        flatten(rows)
        write_png(dst, w, h, rows)
        print(f'{dst}: {w}x{h} {os.path.getsize(dst) // 1024}KB')
    finally:
        os.unlink(bmp)


if __name__ == '__main__':
    main()
