#!/usr/bin/env python3
"""Рисует иконку приложения из настоящих текстур: Солнце, орбита и Земля.

Результат — в папке icons/: icon-512.png, icon-192.png, apple-touch-icon.png (180),
icon-maskable-512.png (с запасом по краям для Android) и favicon.ico (16/32/48).
Запуск: python3 tools/make_icon.py   (нужны Pillow и numpy)
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
TEX = ROOT / 'textures'
OUT = ROOT / 'icons'
N = 1024  # рисуем крупно, затем уменьшаем

yy, xx = np.mgrid[0:N, 0:N].astype(np.float32) + 0.5


def load(name):
    return np.asarray(Image.open(TEX / name).convert('RGB'), dtype=np.float32) / 255.0


def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, None)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def sphere(cx, cy, r, tilt=0.0):
    """Нормали ортографической сферы и координаты текстуры для пикселей диска."""
    dx, dy = (xx - cx) / r, (cy - yy) / r
    d2 = dx * dx + dy * dy
    mask = d2 < 1.0
    nz = np.sqrt(np.clip(1.0 - d2, 0, 1))
    # наклон оси — поворот вокруг оси X экрана
    ny = dy * np.cos(tilt) + nz * np.sin(tilt)
    nzr = -dy * np.sin(tilt) + nz * np.cos(tilt)
    lon = np.arctan2(dx, nzr)
    lat = np.arcsin(np.clip(ny, -1, 1))
    # сглаживание края диска
    edge = np.clip((1.0 - np.sqrt(d2)) * r / 1.2, 0, 1)
    return mask, edge, (dx, dy, nz), lon, lat


def sample(tex, lon, lat, lon0=0.0):
    h, w, _ = tex.shape
    u = ((lon + lon0) / (2 * np.pi) + 0.5) % 1.0
    v = 0.5 - lat / np.pi
    return tex[np.clip((v * h).astype(int), 0, h - 1), np.clip((u * w).astype(int), 0, w - 1)]


def render():
    img = np.zeros((N, N, 3), np.float32)

    # Фон: глубокий космос с лёгким градиентом и звёздами
    r = np.hypot(xx - N * 0.3, yy - N * 0.7) / N
    img += np.stack([0.010, 0.013, 0.030]) * np.clip(1.2 - r, 0, 1)[..., None] ** 2
    rng = np.random.default_rng(7)
    for _ in range(140):
        x, y = rng.uniform(0, N, 2)
        b = rng.uniform(0.15, 0.9) ** 2
        s = rng.uniform(0.8, 1.8)
        img += b * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (s * s))[..., None] * np.array([0.9, 0.93, 1.0])

    sun_c, sun_r = (np.float32(N * 0.34), np.float32(N * 0.64)), N * 0.235
    earth_c, earth_r = (np.float32(N * 0.745), np.float32(N * 0.3)), N * 0.115

    # Орбита — наклонный эллипс через центр Земли; задняя половина уходит за Солнце
    orbit = Image.new('L', (N * 2, N * 2), 0)
    d = ImageDraw.Draw(orbit)
    ang = np.deg2rad(-24)
    ex, ey = earth_c[0] - sun_c[0], earth_c[1] - sun_c[1]
    # подбираем полуоси так, чтобы Земля лежала на эллипсе
    lx = ex * np.cos(-ang) - ey * np.sin(-ang)
    ly = ex * np.sin(-ang) + ey * np.cos(-ang)
    ratio = 0.34
    a = np.sqrt(lx ** 2 + (ly / ratio) ** 2)
    b = a * ratio
    t = np.linspace(0, 2 * np.pi, 720)
    px = sun_c[0] + a * np.cos(t) * np.cos(ang) - b * np.sin(t) * np.sin(ang)
    py = sun_c[1] + a * np.cos(t) * np.sin(ang) + b * np.sin(t) * np.cos(ang)
    front = np.sin(t) > 0  # нижняя половина эллипса — перед Солнцем
    orbit_back = Image.new('L', (N * 2, N * 2), 0)
    db = ImageDraw.Draw(orbit_back)
    for k in range(len(t) - 1):
        seg = [(px[k] * 2, py[k] * 2), (px[k + 1] * 2, py[k + 1] * 2)]
        (d if front[k] else db).line(seg, fill=255, width=7)
    orbit = np.asarray(orbit.resize((N, N), Image.LANCZOS), np.float32) / 255
    orbit_back = np.asarray(orbit_back.resize((N, N), Image.LANCZOS), np.float32) / 255
    orbit_col = np.array([1.0, 0.78, 0.45])
    img += orbit_back[..., None] * orbit_col * 0.22

    # Свечение Солнца (корона и рассеяние)
    rs = np.hypot(xx - sun_c[0], yy - sun_c[1]) / sun_r
    rg = np.maximum(rs, 1.0) - 1.0  # непрерывно у края — без тёмного ободка
    glow = 0.75 * np.exp(-rg * 7.0) + 0.16 * np.exp(-rg * 2.2) + 0.03 * np.exp(-rg * 0.7)
    img += glow[..., None] * np.array([1.0, 0.55, 0.2])

    # Солнце: текстура + потемнение к краю
    sun_tex = srgb_to_lin(load('2k_sun.jpg'))
    m, edge, (nx, ny, nz), lon, lat = sphere(*sun_c, sun_r, tilt=0.25)
    col = sample(sun_tex, lon, lat, 1.3)
    mu = nz
    limb = 1 - 0.55 * (1 - mu) - 0.2 * (1 - mu) ** 2
    tint = np.stack([np.ones_like(mu), 0.42 + 0.38 * mu ** 0.6, 0.1 + 0.3 * mu ** 0.8], -1)
    sun = (col * 1.1 + 0.18) * limb[..., None] * tint * 1.25
    a_ = (edge * m)[..., None]
    img = img * (1 - a_) + sun * a_

    img += orbit[..., None] * orbit_col * 0.5

    # Земля: день, облака, ночь, блик, атмосфера; освещение от Солнца
    day = srgb_to_lin(load('2k_earth_daymap.jpg'))
    clouds = load('2k_earth_clouds.jpg')[..., :1]
    night = srgb_to_lin(load('2k_earth_nightmap.jpg'))
    m, edge, (nx, ny, nz), lon, lat = sphere(*earth_c, earth_r, tilt=0.4)
    L = np.array([sun_c[0] - earth_c[0], -(sun_c[1] - earth_c[1]), earth_r * 1.4], np.float32)
    L /= np.linalg.norm(L)
    ndl = nx * L[0] + ny * L[1] + nz * L[2]
    lon0 = 2.2  # Африка и Европа к зрителю
    c = sample(clouds, lon, lat, lon0)[..., 0]
    surf = sample(day, lon, lat, lon0) * (1 - 0.45 * c[..., None])
    diff = np.clip(ndl, 0, 1)[..., None]
    sunset = np.stack([np.ones_like(ndl), 0.55 + 0.45 * np.clip(ndl / 0.3, 0, 1), 0.3 + 0.7 * np.clip(ndl / 0.3, 0, 1)], -1)
    earth = (surf * 1.6 + c[..., None] * 1.1) * diff * sunset
    dark = np.clip((0.05 - ndl) / 0.25, 0, 1)[..., None]
    earth += sample(night, lon, lat, lon0) ** 2 * 2.0 * dark * (1 - 0.8 * c[..., None])
    fres = (1 - nz) ** 3
    lit = np.clip((ndl + 0.25) / 0.6, 0, 1)
    earth = earth * (1 - (fres * lit * 0.7)[..., None]) + (fres * lit)[..., None] * np.array([0.35, 0.6, 1.0]) * 1.4
    a_ = (edge * m)[..., None]
    img = img * (1 - a_) + earth * a_

    # Внешний ореол атмосферы
    re = np.hypot(xx - earth_c[0], yy - earth_c[1]) / earth_r
    dirx, diry = (xx - earth_c[0]) / (re * earth_r + 1e-6), -(yy - earth_c[1]) / (re * earth_r + 1e-6)
    side = np.clip((dirx * L[0] + diry * L[1]) / np.hypot(L[0], L[1]) * 0.9 + 0.35, 0, 1)
    halo = np.exp(-(re - 1) * 28) * (re >= 1) * side
    img += halo[..., None] * np.array([0.35, 0.6, 1.0]) * 0.9

    # Тонмаппинг (ACES) и sRGB
    x = img * 1.05
    x = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)
    out = lin_to_srgb(np.clip(x, 0, 1))
    return Image.fromarray((out * 255 + 0.5).astype(np.uint8))


def rounded(im, radius_frac=0.225):
    """Скруглённый квадрат с прозрачными углами (для favicon)."""
    s = im.size[0]
    mask = Image.new('L', (s * 4, s * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, s * 4 - 1, s * 4 - 1), radius=int(s * 4 * radius_frac), fill=255)
    out = im.convert('RGBA')
    out.putalpha(mask.resize((s, s), Image.LANCZOS))
    return out


def main():
    OUT.mkdir(exist_ok=True)
    full = render()
    full.resize((512, 512), Image.LANCZOS).save(OUT / 'icon-512.png', optimize=True)
    full.resize((192, 192), Image.LANCZOS).save(OUT / 'icon-192.png', optimize=True)
    full.resize((180, 180), Image.LANCZOS).save(OUT / 'apple-touch-icon.png', optimize=True)
    # Maskable: Android может обрезать до круга — оставляем 10 % поля
    pad = Image.new('RGB', (N, N), (3, 4, 10))
    pad.paste(full.resize((int(N * 0.8),) * 2, Image.LANCZOS), (int(N * 0.1),) * 2)
    pad.resize((512, 512), Image.LANCZOS).save(OUT / 'icon-maskable-512.png', optimize=True)
    # Favicon: скруглённый, чуть резче для мелких размеров
    fav = rounded(full.resize((256, 256), Image.LANCZOS).filter(ImageFilter.UnsharpMask(1.2, 60, 2)))
    fav.save(OUT / 'favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)])
    fav.resize((64, 64), Image.LANCZOS).save(OUT / 'favicon-64.png', optimize=True)
    print('Готово:', ', '.join(sorted(p.name for p in OUT.iterdir())))


if __name__ == '__main__':
    main()
