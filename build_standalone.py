#!/usr/bin/env python3
"""Собирает solar-system.html — один файл, который открывается двойным кликом без сервера и без интернета.

Внутрь встраиваются: Three.js (vendor/three.js), весь код (main.js, data.js, shaders.js, previews.js),
2K-текстуры в WebP и небо 8K как data-URI, иконки. Подгрузка 8K по требованию в автономной версии
отключена, чтобы файл оставался небольшим (~10 МБ).

Запуск:  python3 build_standalone.py   (после tools/build_vendor.sh и tools/build_textures.py)
"""
import base64
import mimetypes
import re
from pathlib import Path

ROOT = Path(__file__).parent
TEX = ROOT / 'textures'
OUT = ROOT / 'solar-system.html'

html = (ROOT / 'index.html').read_text(encoding='utf-8')
main = (ROOT / 'main.js').read_text(encoding='utf-8')
data = (ROOT / 'data.js').read_text(encoding='utf-8')
shaders = (ROOT / 'shaders.js').read_text(encoding='utf-8')
previews = (ROOT / 'previews.js').read_text(encoding='utf-8')
vendor = (ROOT / 'vendor' / 'three.js').read_text(encoding='utf-8')
mimetypes.add_type('image/webp', '.webp')


def patch(src, old, new):
    if old not in src:
        raise SystemExit(f'Не найден фрагмент для замены: {old!r}')
    return src.replace(old, new)


# --- Three.js: ES-модуль → объект THREE внутри замыкания (короткие имена не пересекутся с кодом)
m = re.search(r'export\s*\{([^}]*)\};?', vendor)
pairs = []
for item in m.group(1).split(','):
    local, _, exported = item.strip().partition(' as ')
    pairs.append(f'{exported or local}: {local}')
vendor_block = ('const THREE = (() => {\n' + vendor[:m.start()] + vendor[m.end():] +
                '\nreturn { ' + ', '.join(pairs) + ' };\n})();\n')

imports = re.findall(r"^import .*? from './vendor/three\.js';\n", main, re.M)
named = re.search(r"^import \{([^}]*)\} from './vendor/three\.js';", main, re.M).group(1)
for line in imports:
    main = main.replace(line, '')
main = vendor_block + f'const {{{named}}} = THREE;\n' + main

# --- Остальные модули
shader_names = re.findall(r'^export const (\w+)', shaders, re.M)
shaders_block = 'const S = (() => {\n' + re.sub(r'^export ', '', shaders, flags=re.M) + \
    f'\nreturn {{ {", ".join(shader_names)} }};\n}})();\n'
data_block = re.sub(r'^export ', '', data, flags=re.M)
previews_block = re.sub(r'^export ', '', previews, flags=re.M)

main = patch(main, "import { BODIES, AU_KM } from './data.js';\n", data_block + '\n')
main = patch(main, "import { PREVIEWS } from './previews.js';\n", previews_block + '\n')
main = patch(main, "import * as S from './shaders.js';\n", shaders_block + '\n')

# --- Текстуры: первые (2K) файлы из списков в data.js + небо 2K/8K
needed = set()
for lst in re.findall(r"\[([^\]]*)\]", ''.join(re.findall(r"tex:\s*\{[^}]*\}", data_block, re.S))):
    names = re.findall(r"'([^']+)'", lst)
    if names:
        needed.add(names[0])
needed |= {'web/2k_stars_milky_way.webp', 'web/8k_stars_milky_way.webp'}
needed = {n for n in needed if not n.endswith('.png')}   # кольца Сатурна уже в превью

entries = []
for name in sorted(needed):
    mime = mimetypes.guess_type(name)[0] or 'image/webp'
    entries.append(f'  {name!r}: "data:{mime};base64,{base64.b64encode((TEX / name).read_bytes()).decode()}"')
tex_block = 'const TEXTURE_DATA = {\n' + ',\n'.join(entries) + '\n};\n'

main = patch(main, "const TEX = 'textures/';\n", "const TEX = 'textures/';\n" + tex_block)
main = patch(main, "const textureURL = (file) => new URL(TEX + file, location.href).href;",
             "const textureURL = (file) => TEXTURE_DATA[file] || new URL(TEX + file, location.href).href;")
main = patch(main, "const canHD = renderer.capabilities.maxTextureSize >= 8192;",
             "const canHD = false; // автономная версия: только встроенные текстуры")
# Небо 8K встроено — включаем его и без режима 8K
main = patch(main, "if (bgDone === bgTotal && hdEnabled) setSkyHD(true);", "if (bgDone === bgTotal) setSkyHD(true);")
main = patch(main, "      if (hdEnabled) sky.material.map = t;", "      sky.material.map = t;")

# --- HTML
html = patch(html, '<script type="module" src="main.js"></script>',
             '<script type="module">\n' + main.replace('</script', '<\\/script') + '\n</script>')
html = re.sub(r'\n<script id="fileCheck">.*?</script>', '', html)
html = re.sub(r'<!-- Модули грузим.*?-->\n(<link rel="modulepreload"[^>]*>\n?)+', '', html, flags=re.S)
html = patch(html, '</style>', '  #btnHD { display: none; }\n</style>')


def data_uri(path):
    return f'data:{mimetypes.guess_type(path.name)[0]};base64,' + base64.b64encode(path.read_bytes()).decode()


html = patch(html, 'href="icons/favicon.ico" sizes="16x16 32x32 48x48"', f'href="{data_uri(ROOT / "icons/favicon-64.png")}" sizes="64x64"')
html = re.sub(r'\n<link rel="icon" href="icons/favicon-64.png"[^>]*>', '', html)
html = patch(html, 'href="icons/apple-touch-icon.png"', f'href="{data_uri(ROOT / "icons/apple-touch-icon.png")}"')
html = re.sub(r'\n<link rel="manifest"[^>]*>', '', html)

OUT.write_text(html, encoding='utf-8')
print(f'{OUT.name}: {OUT.stat().st_size / 1e6:.1f} МБ, текстур: {len(needed)}')
