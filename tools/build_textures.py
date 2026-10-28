#!/usr/bin/env python3
"""Готовит текстуры для сайта.

1. Исходные JPG/PNG из textures/ → textures/web/*.webp (вдвое меньше при том же качестве).
2. Карты спутников из мозаик USGS (NASA: Galileo, Voyager, Cassini, Viking, New Horizons)
   → textures/web/moons/<имя>_2k.webp и _4k.webp. Исходники (сотни МБ) скачиваются в кэш-папку.
3. previews.js — крошечные превью всех карт в виде data-URI: сцена показывается сразу,
   а полноразмерные текстуры подгружаются в фоне.

Запуск: python3 tools/build_textures.py [--cache ПАПКА]   (нужны Pillow с WebP и numpy)
"""
import argparse
import base64
import io
import json
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'textures'
OUT = SRC / 'web'
S3 = 'https://asc-pds-services.s3.us-west-2.amazonaws.com/'

# Исходник → (качество WebP, в оттенках серого)
PLAIN = {
    '2k_sun.jpg': 88, '8k_sun.jpg': 88,
    '2k_mercury.jpg': 80, '8k_mercury.jpg': 76,
    '2k_venus_atmosphere.jpg': 90, '4k_venus_atmosphere.jpg': 90,
    '2k_earth_daymap.jpg': 84, '8k_earth_daymap.jpg': 80,
    '2k_earth_nightmap.jpg': 84, '8k_earth_nightmap.jpg': 80,
    '2k_earth_clouds.jpg': 82, '8k_earth_clouds.jpg': 76,
    'earth_normal_2048.jpg': 90, 'earth_specular_2048.jpg': 85,
    '2k_moon.jpg': 80, '8k_moon.jpg': 76,
    '2k_mars.jpg': 82, '8k_mars.jpg': 78,
    '2k_jupiter.jpg': 90, '8k_jupiter.jpg': 92,
    '2k_saturn.jpg': 90, '8k_saturn.jpg': 92,
    '2k_uranus.jpg': 92, '2k_neptune.jpg': 92,
    '2k_stars_milky_way.jpg': 94, '8k_stars_milky_way.jpg': 95,
}

# Спутники: файл в хранилище USGS, сдвиг долготы (карты 0…360° → −180…180°),
# раскраска чёрно-белых мозаик (тёмный, светлый тон) по цветным снимкам миссий.
MOONS = {
    'io':       ('wms_basemaps/Jupiter/Io/color/io00n180.png', True, None),
    'europa':   ('wms_basemaps/Jupiter/Europa/europa00n180.png', True, ((0.50, 0.38, 0.28), (0.97, 0.95, 0.90))),
    'ganymede': ('wms_basemaps/Jupiter/Ganymede/ganymede00n180.png', True, ((0.33, 0.30, 0.27), (0.88, 0.86, 0.82))),
    'callisto': ('wms_basemaps/Jupiter/Callisto/callisto00n180.png', True, ((0.16, 0.14, 0.12), (0.80, 0.77, 0.72))),
    'titan':    ('wms_basemaps/Saturn/Titan/Cassini/Titan_ISS_P19658_Mosaic_Global_4km_clon0.tif', False, ((0.45, 0.30, 0.14), (0.95, 0.76, 0.46))),
    'phobos':   ('wms_basemaps/Phobos/phobos-cylindrical_dd360.tif', True, ((0.16, 0.14, 0.12), (0.66, 0.60, 0.54))),
    'deimos':   ('wms_basemaps/Deimos/deimoscyl4.jpg', False, ((0.20, 0.18, 0.15), (0.72, 0.66, 0.58))),
    'triton':   ('wms_basemaps3/Neptune/Triton/Voyager2/Triton_Voyager2_ClrMosaic_GlobalFill_600m_cog.tif', False, None),
    'pluto':    ('wms_basemaps3/Pluto/Pluto/Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit_cog.tif', False, ((0.30, 0.13, 0.06), (0.99, 0.93, 0.85))),
    'charon':   ('wms_basemaps3/Pluto/Charon/Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit_cog.tif', False, ((0.22, 0.21, 0.20), (0.86, 0.84, 0.82))),
}
HD_MOONS = {'europa', 'ganymede', 'callisto', 'triton', 'pluto', 'charon'}  # исходники ≥ 4K


def webp(im, path, q):
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, 'WEBP', quality=q, method=6)
    return path.stat().st_size


def colorize(gray, dark, light, curve=1.0):
    g = (np.asarray(gray, np.float32) / 255.0) ** curve
    d, l = np.array(dark, np.float32), np.array(light, np.float32)
    rgb = d + (l - d) * g[..., None]
    return Image.fromarray(np.clip(rgb * 255 + 0.5, 0, 255).astype(np.uint8))


def resize_f(a, size):
    """Ресайз float-массива (H, W[, C]) по каналам."""
    chans = a[..., None] if a.ndim == 2 else a
    out = np.stack([np.asarray(Image.fromarray(chans[..., c]).resize(size, Image.BILINEAR)) for c in range(chans.shape[2])], -1)
    return out[..., 0] if a.ndim == 2 else out


def fill_gaps(a, m):
    """Заливает области без съёмки (m=0) плавным продолжением соседних цветов (pull-push)."""
    levels = [(a * (m[..., None] if a.ndim == 3 else m), m)]
    while levels[-1][1].shape[0] > 4:
        p, w = levels[-1]
        h, wd = w.shape[0] // 2 * 2, w.shape[1] // 2 * 2
        p, w = p[:h, :wd], w[:h, :wd]
        shp = (h // 2, 2, wd // 2, 2) + p.shape[2:]
        levels.append((p.reshape(shp).mean((1, 3)), w.reshape(h // 2, 2, wd // 2, 2).mean((1, 3))))
    p, w = levels[-1]
    col = p / np.maximum(w, 1e-6)[..., None] if p.ndim == 3 else p / np.maximum(w, 1e-6)
    for p, w in reversed(levels[:-1]):
        up = resize_f(col.astype(np.float32), (w.shape[1], w.shape[0]))
        wc = np.clip(w, 0, 1)
        col = p + (1 - wc[..., None] if p.ndim == 3 else 1 - wc) * up
    return col


def moon_map(name, cache):
    key, roll, tone = MOONS[name]
    src = cache / (name + Path(key).suffix)
    if not src.exists():
        print(f'  скачиваю {name} из USGS…')
        cache.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(S3 + key, src)
    im = Image.open(src)
    im = im.convert('L' if tone else 'RGB')
    if im.width > 8192:  # огромные мозаики сначала грубо уменьшаем — дальше LANCZOS до 4K/2K
        im = im.reduce(im.width // 4096)
    a = np.asarray(im).astype(np.float32)
    if roll:
        a = np.roll(a, a.shape[1] // 2, axis=1)
    # Нет данных = чистый ноль; маску чуть «отъедаем» от краёв
    lum = a if a.ndim == 2 else a.sum(-1)
    m = (lum > 0).astype(np.float32)
    if name == 'triton':
        # Север Тритона Voyager снимал почти в темноте — тёмно-зелёная полоса не настоящий цвет
        lat = np.linspace(90, -90, a.shape[0])[:, None]
        m *= ((lat < 8) | (lum > 330)).astype(np.float32)
    m = np.asarray(Image.fromarray(m).filter(ImageFilter.MinFilter(5)))
    size = (4096, 2048) if a.shape[1] >= 4096 else (2048, 1024)
    a = resize_f(a * (m[..., None] if a.ndim == 3 else m), size)
    m = resize_f(m, size)
    a = a / np.maximum(m[..., None] if a.ndim == 3 else m, 1e-6)
    valid = (m > 0.5).astype(np.float32)
    a = fill_gaps(a, valid)
    # Большие несфотографированные области: чем дальше от снятого, тем ближе к среднему цвету
    small = np.asarray(Image.fromarray(valid).resize((360, 180), Image.BILINEAR)) > 0.5
    dist = np.where(small, 0, 99).astype(np.float32)
    reach = small.copy()
    for step in range(1, 40):
        reach = np.asarray(Image.fromarray(reach.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(3))) > 0
        dist[(dist == 99) & reach] = step
    w = np.clip((resize_f(dist, size) - 4) / 18, 0, 1)
    mean = (a * valid[..., None]).sum((0, 1)) / valid.sum() if a.ndim == 3 else (a * valid).sum() / valid.sum()
    a = a * (1 - w[..., None]) + mean * w[..., None] if a.ndim == 3 else a * (1 - w) + mean * w
    if name == 'triton':
        # Баланс белого: у мозаики Voyager зелёный сдвиг, сам Тритон розовато-белый
        a = a * (np.array([212, 196, 186], np.float32) / mean)
    im = Image.fromarray(np.clip(a + 0.5, 0, 255).astype(np.uint8))
    if name == 'charon':
        # Красноватая северная шапка (Mordor Macula) по цветным снимкам New Horizons
        rgb = np.asarray(colorize(im, *tone), np.float32)
        lat = np.linspace(90, -90, rgb.shape[0])[:, None, None]
        w = np.clip((lat - 50) / 25, 0, 1)
        rgb = rgb * (1 - w * np.array([0.12, 0.38, 0.55]))
        return Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))
    if tone:
        return colorize(im, *tone, curve=0.9 if name == 'pluto' else 1.0)
    return im


def data_uri(im, q=60):
    buf = io.BytesIO()
    im.save(buf, 'WEBP', quality=q, method=6)
    return 'data:image/webp;base64,' + base64.b64encode(buf.getvalue()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', type=Path, default=ROOT / '.cache' / 'usgs', help='куда скачивать исходники USGS')
    ap.add_argument('--skip-moons', action='store_true')
    args = ap.parse_args()

    previews = {}
    total = 0
    for name, q in PLAIN.items():
        im = Image.open(SRC / name).convert('RGB')
        out = OUT / (Path(name).stem + '.webp')
        total += webp(im, out, q)
        rel = 'web/' + out.name
        if name.startswith('2k_') or name.startswith('earth_'):
            size = (1024, 512) if 'milky_way' in name else (256, 128)
            previews[rel] = data_uri(im.resize(size, Image.LANCZOS), 55 if 'milky' in name else 60)
        print(f'{rel:38s} {out.stat().st_size // 1024:6d} КБ')

    ring = Image.open(SRC / '8k_saturn_ring_alpha.png')
    ring.save(OUT / '8k_saturn_ring_alpha.png', optimize=True)  # PNG с альфой — 65 КБ, оставляем
    previews['web/8k_saturn_ring_alpha.png'] = 'data:image/png;base64,' + base64.b64encode(
        (OUT / '8k_saturn_ring_alpha.png').read_bytes()).decode()

    if not args.skip_moons:
        for name in MOONS:
            im = moon_map(name, args.cache)
            two = im.resize((2048, 1024), Image.LANCZOS)
            total += webp(two, OUT / 'moons' / f'{name}_2k.webp', 82)
            previews[f'web/moons/{name}_2k.webp'] = data_uri(two.resize((256, 128), Image.LANCZOS))
            line = f'web/moons/{name}_2k.webp'
            if name in HD_MOONS:
                total += webp(im.resize((4096, 2048), Image.LANCZOS), OUT / 'moons' / f'{name}_4k.webp', 80)
                line += ' + 4k'
            print(f'{line:38s}')

    js = ('// Сгенерировано tools/build_textures.py — крошечные превью текстур для мгновенного старта.\n'
          'export const PREVIEWS = ' + json.dumps(previews, indent=0) + ';\n')
    (ROOT / 'previews.js').write_text(js, encoding='utf-8')
    print(f'previews.js: {len(js) // 1024} КБ, всего WebP: {total / 1e6:.1f} МБ')


if __name__ == '__main__':
    main()
