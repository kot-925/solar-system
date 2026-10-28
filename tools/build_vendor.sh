#!/bin/bash
# Собирает vendor/three.js — один минифицированный ES-модуль с Three.js и нужными аддонами.
# Вместо 13 запросов к CDN цепочкой — один файл с того же сайта (быстрее старт, работает офлайн).
# В сборку попадает только то, что используется в main.js (THREE.Xxx и аддоны ниже).
#
# Запуск: tools/build_vendor.sh   (нужен Node.js; three и esbuild ставятся во временную папку)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
THREE_VERSION=0.170.0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "three@$THREE_VERSION" esbuild@0.24.2

# Используемые в main.js классы и константы THREE.*
SYMBOLS=$(grep -oE 'THREE\.[A-Za-z0-9_]+' "$ROOT/main.js" | sed 's/THREE\.//' | sort -u | paste -sd, -)

cat > entry.js <<EOF
export { $SYMBOLS } from 'three';
export { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
export { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
export { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
export { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
export { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
export { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
EOF

mkdir -p "$ROOT/vendor"
npx esbuild entry.js --bundle --format=esm --minify --target=es2020 --legal-comments=eof \
  --outfile="$ROOT/vendor/three.js"
echo "vendor/three.js: $(( $(stat -f%z "$ROOT/vendor/three.js") / 1024 )) КБ (three@$THREE_VERSION)"
