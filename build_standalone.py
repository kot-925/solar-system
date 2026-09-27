#!/usr/bin/env python3
"""Собирает solar-system.html — один файл, который открывается двойным кликом без сервера.

Весь JS (main.js, data.js, shaders.js) встраивается в страницу, текстуры — как data-URI.
Встраиваются 2K-текстуры (+ 8K небо); подгрузка 8K по требованию в автономной версии
отключена, чтобы файл оставался ~15 МБ. Three.js по-прежнему грузится с CDN (нужен интернет).

Запуск:  python3 build_standalone.py
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


def patch(src, old, new):
    if old not in src:
        raise SystemExit(f'Не найден фрагмент для замены: {old!r}')
    return src.replace(old, new)


# --- Модули → один скрипт
shader_names = re.findall(r'^export const (\w+)', shaders, re.M)
shaders_block = 'const S = (() => {\n' + re.sub(r'^export ', '', shaders, flags=re.M) + \
    f'\nreturn {{ {", ".join(shader_names)} }};\n}})();\n'
data_block = re.sub(r'^export ', '', data, flags=re.M)

main = patch(main, "import { BODIES, AU_KM } from './data.js';\n", data_block + '\n')
main = patch(main, "import * as S from './shaders.js';\n", shaders_block + '\n')

# --- Текстуры: 2K-файлы (первые в списках) + 8K небо
files = set(re.findall(r"tex:\s*\{[^}]*\}", data_block, re.S))
needed = set()
for block in files:
    for lst in re.findall(r"\[([^\]]*)\]", block):
        names = re.findall(r"'([^']+)'", lst)
        if names:
            needed.add(names[0])
needed |= {'2k_stars_milky_way.jpg', '8k_stars_milky_way.jpg'}

entries = []
for name in sorted(needed):
    path = TEX / name
    mime = mimetypes.guess_type(name)[0] or 'image/jpeg'
    b64 = base64.b64encode(path.read_bytes()).decode('ascii')
    entries.append(f'  {name!r}: "data:{mime};base64,{b64}"')
tex_block = 'const TEXTURE_DATA = {\n' + ',\n'.join(entries) + '\n};\n'

main = patch(main, "const TEX = 'textures/';\n", "const TEX = 'textures/';\n" + tex_block)
main = patch(main, "loader.load(TEX + file)", "loader.load(TEXTURE_DATA[file] || TEX + file)")
main = patch(main, "const canHD = renderer.capabilities.maxTextureSize >= 8192;", "const canHD = false; // автономная версия: только встроенные текстуры")
sky8k = "renderer.capabilities.maxTextureSize >= 8192 ? '8k_stars_milky_way.jpg' : '2k_stars_milky_way.jpg'"
main = patch(main, "map: tex('2k_stars_milky_way.jpg')", f"map: tex({sky8k})")
main = patch(main, "if (location.protocol === 'file:') $('error').style.display = 'block';\n", '')

# --- HTML: встраиваем скрипт, прячем кнопку 8K
html = patch(html, '<script type="module" src="main.js"></script>',
             '<script type="module">\n' + main.replace('</script', '<\\/script') + '\n</script>')
html = patch(html, '</style>', '  #btnHD { display: none; }\n</style>')

# Иконки встраиваем, чтобы файл оставался самодостаточным
def data_uri(path):
    return f'data:{mimetypes.guess_type(path.name)[0]};base64,' + base64.b64encode(path.read_bytes()).decode()
html = patch(html, 'href="icons/favicon.ico" sizes="16x16 32x32 48x48"', f'href="{data_uri(ROOT / "icons/favicon-64.png")}" sizes="64x64"')
html = re.sub(r'\n<link rel="icon" href="icons/favicon-64.png"[^>]*>', '', html)
html = patch(html, 'href="icons/apple-touch-icon.png"', f'href="{data_uri(ROOT / "icons/apple-touch-icon.png")}"')
html = re.sub(r'\n<link rel="manifest"[^>]*>', '', html)

OUT.write_text(html, encoding='utf-8')
print(f'{OUT.name}: {OUT.stat().st_size / 1e6:.1f} МБ, текстур: {len(needed)}')
