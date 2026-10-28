import * as THREE from './vendor/three.js';
import { OrbitControls, EffectComposer, RenderPass, UnrealBloomPass, OutputPass, CSS2DRenderer, CSS2DObject } from './vendor/three.js';
import { BODIES, AU_KM } from './data.js';
import { PREVIEWS } from './previews.js';
import * as S from './shaders.js';

const DEG = Math.PI / 180;
const TEX = 'textures/';
const OBLIQUITY = 23.4392911 * DEG;
const SUN_R_KM = 695700;
const LIGHT = 1.2;         // освещённость от Солнца (до тонмаппинга)
const AMBIENT = 0.0025;    // почти чёрная ночная сторона, как в реальности

// ---------------------------------------------------------------- Масштаб
// Два режима: «наглядный» (размеры увеличены, расстояния сжаты) и «реальный»
// (1 единица = 1000 км). Переход — интерполяция в логарифмах.
const VIS_AU = 80;                               // единиц на √а.е.
const visDist = (km) => VIS_AU * Math.sqrt(km / AU_KM);
const visRadius = (km, id) => (id === 'sun' ? 15 : 2.5 * Math.sqrt(km / 6371));
const visMoonDist = (aKm, parentRkm, parentVisR) => parentVisR * 1.4 * Math.pow(aKm / parentRkm, 0.3);
let scaleT = 0;          // 0 — наглядный, 1 — реальный
let scaleTarget = 0;
const lmix = (a, b, t) => Math.exp(Math.log(a) * (1 - t) + Math.log(b) * t);
const heliScale = (km) => lmix(visDist(km), km / 1000, scaleT);

// ---------------------------------------------------------------- Время
let simTime = Date.now();       // мс, UTC
const SPEEDS = [1, 60, 3600, 21600, 86400, 604800, 2629800, 31557600];
const SPEED_LABELS = ['реальное время', '1 мин / с', '1 час / с', '6 часов / с', '1 сутки / с', '1 неделя / с', '1 месяц / с', '1 год / с'];
let speedIdx = 4, paused = false, reverse = false;
const daysJ2000 = (ms) => ms / 86400000 + 2440587.5 - 2451545.0;
// Выше 1 сут/с вращение планет вокруг оси замедляется до 1 сут/с — иначе стробоскоп
// (Земля делала бы 365 оборотов в секунду). Орбиты и синхронные спутники — всегда точные.
const SPIN_MAX_RATE = 1;        // суток модели в секунду
let spinD = daysJ2000(simTime);

// ---------------------------------------------------------------- Координаты
// Сцена: X = x эклиптики, Y = z (северный полюс эклиптики вверх), Z = −y.
const eclToScene = (x, y, z, out = new THREE.Vector3()) => out.set(x, z, -y);
function eqToScene(v) {
  const c = Math.cos(OBLIQUITY), s = Math.sin(OBLIQUITY);
  return eclToScene(v.x, v.y * c + v.z * s, -v.y * s + v.z * c);
}
const radec = (ra, dec) => new THREE.Vector3(Math.cos(dec * DEG) * Math.cos(ra * DEG), Math.cos(dec * DEG) * Math.sin(ra * DEG), Math.sin(dec * DEG));

// Ориентация экватора тела по IAU: Y — северный полюс, X — восходящий узел экватора.
function poleFrame(ra, dec) {
  const pole = eqToScene(radec(ra, dec)).normalize();
  const node = eqToScene(radec(ra + 90, 0)).normalize();
  const z = new THREE.Vector3().crossVectors(node, pole).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(node, pole, z));
}

function solveKepler(M, e) {
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 6; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  return E;
}

// Кеплеровы элементы → положение в эклиптических координатах (в единицах a)
function orbitalToEcl(a, e, i, O, w, E, out) {
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cO = Math.cos(O), sO = Math.sin(O), cw = Math.cos(w), sw = Math.sin(w), ci = Math.cos(i), si = Math.sin(i);
  const x = (cw * cO - sw * sO * ci) * xp + (-sw * cO - cw * sO * ci) * yp;
  const y = (cw * sO + sw * cO * ci) * xp + (-sw * sO + cw * cO * ci) * yp;
  const z = (sw * si) * xp + (cw * si) * yp;
  return eclToScene(x, y, z, out);
}

function planetElements(o, d) {
  const T = d / 36525;
  const el = (k) => o[k][0] + o[k][1] * T;
  const a = el('a'), e = el('e'), i = el('i') * DEG, L = el('L') * DEG, wb = el('w') * DEG, O = el('O') * DEG;
  return { a, e, i, O, w: wb - O, M: L - wb };
}

// Гелиоцентрическое положение в км
function planetPosKm(body, d, out) {
  const el = planetElements(body.orbit, d);
  const E = solveKepler(((el.M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), el.e);
  return orbitalToEcl(el.a * AU_KM, el.e, el.i, el.O, el.w, E, out);
}

// Луна: упрощённые элементы (П. Шлитер), эклиптика даты
function lunaElements(d) {
  const dd = d + 1.5;
  return {
    O: (125.1228 - 0.0529538083 * dd) * DEG, i: 5.1454 * DEG, w: (318.0634 + 0.1643573223 * dd) * DEG,
    e: 0.0549, M: (115.3654 + 13.0649929509 * dd) * DEG,
  };
}
function lunaPosKm(d, out) {
  const el = lunaElements(d);
  return orbitalToEcl(384400, el.e, el.i, el.O, el.w, solveKepler(el.M % (2 * Math.PI), el.e), out);
}

// ---------------------------------------------------------------- Рендерер
const container = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);
const maxAniso = renderer.capabilities.getMaxAnisotropy();
const canHD = renderer.capabilities.maxTextureSize >= 8192;

const labelRenderer = new CSS2DRenderer({ element: document.getElementById('labels') });
labelRenderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 1e-4, 1e11);
camera.position.set(0, 260, 520);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.rotateSpeed = 0.55;
controls.zoomSpeed = 1.1;
controls.minDistance = 20;
controls.maxDistance = 5e7;

const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.4, 0.35, 1.2);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------- Качество: подстройка разрешения под видеокарту
// Начинаем с разумного числа пикселей и следим за пропущенными кадрами: если видеокарта
// не успевает — снижаем разрешение рендера на ступень, если долго всё плавно — повышаем.
const PR_MAX = Math.min(devicePixelRatio || 1, 2);
const PR_MIN = Math.min(1, PR_MAX);
const BELT_PX = 1;
const quality = { pr: PR_MAX, ceiling: PR_MAX, vsync: 1000 / 60, winMin: Infinity, slow: 0, n: 0, t0: 0, calm: 0, calmSince: 0, skip: 0 };
const belts = [];

function applyQuality(pr) {
  quality.pr = pr;
  renderer.setPixelRatio(pr);
  renderer.setSize(innerWidth, innerHeight);
  // При плотности ≥ 1,5 пикселя сглаживание даёт сама плотность — MSAA только тратит видеопамять
  const samples = pr >= 1.5 ? 0 : 4;
  for (const t of [composer.renderTarget1, composer.renderTarget2]) {
    if (t.samples !== samples) { t.samples = samples; t.dispose(); }
  }
  composer.setPixelRatio(pr);
  composer.setSize(innerWidth, innerHeight);
  for (const b of belts) b.mat.uniforms.uSize.value = BELT_PX * pr;
  quality.skip = 20;
}
function initialPixelRatio() {
  const budget = 4.5e6;   // пикселей на кадр для старта; дальше подстроится
  const pr = Math.sqrt(budget / (innerWidth * innerHeight));
  return THREE.MathUtils.clamp(Math.floor(pr * 4) / 4, PR_MIN, PR_MAX);
}
function tuneQuality(dtMs, now) {
  if (quality.skip > 0 || dtMs > 250 || document.hidden) { quality.skip = Math.max(0, quality.skip - 1); return; }
  if (!quality.t0) quality.t0 = now;
  quality.n++;
  quality.winMin = Math.min(quality.winMin, dtMs);
  if (dtMs > quality.vsync * 1.6) quality.slow++;
  if (now - quality.t0 < 2000) return;
  quality.vsync = Math.max(6, quality.winMin);
  const ratio = quality.slow / quality.n;
  if (ratio > 0.2 && quality.pr > PR_MIN) {
    quality.ceiling = quality.pr - 0.25;
    applyQuality(Math.max(PR_MIN, quality.pr - 0.25));
    quality.calm = 0;
  } else if (ratio < 0.03) {
    quality.calm++;
    // Раз в минуту спокойной работы снова пробуем более высокое разрешение
    if (now - quality.calmSince > 60000) { quality.ceiling = Math.min(PR_MAX, quality.ceiling + 0.25); quality.calmSince = now; }
    if (quality.calm >= 3 && quality.pr < quality.ceiling) { applyQuality(Math.min(quality.ceiling, quality.pr + 0.25)); quality.calm = 0; }
  } else quality.calm = 0;
  quality.t0 = now; quality.n = 0; quality.slow = 0; quality.winMin = Infinity;
}
applyQuality(initialPixelRatio());

// ---------------------------------------------------------------- Текстуры
// Сразу показываем крошечные превью (встроены в previews.js), полноразмерные картинки
// грузятся в фоне: декодируются вне основного потока (ImageBitmap) и передаются
// на видеокарту кусками 1024×1024 по несколько миллисекунд за кадр — даже 8K не дёргает анимацию.
const BITMAP_OPTIONS = { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
const textureURL = (file) => new URL(TEX + file, location.href).href;

// Скачивание и декодирование — в отдельном потоке (Web Worker): у больших WebP браузер иначе
// делает часть работы в основном потоке (~50 мс на 8K-файл). Готовый ImageBitmap передаётся без копирования.
const decoder = (() => {
  try {
    const src = `self.onmessage = async (e) => {
      const { id, url, options } = e.data;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.status + ' ' + url);
        const bmp = await createImageBitmap(await res.blob(), options);
        self.postMessage({ id, bmp }, [bmp]);
      } catch (err) { self.postMessage({ id, error: String(err) }); }
    };`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    const pending = new Map();
    let seq = 0;
    w.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error)); else p.resolve(data.bmp);
    };
    return (url) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      w.postMessage({ id, url, options: BITMAP_OPTIONS });
    });
  } catch {
    return null;
  }
})();
const bitmapLoader = new THREE.ImageBitmapLoader();
bitmapLoader.setOptions(BITMAP_OPTIONS);

function prepTex(t, srgb) {
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = maxAniso;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}
function loadBitmap(file) {
  const url = textureURL(file);
  if (decoder) return decoder(url);
  return new Promise((resolve, reject) => bitmapLoader.load(url, resolve, undefined, reject));
}

const texReg = new Map();      // путь 2K-файла → { u: {value}, list, srgb, level, low, hd }
const previewPromises = [];
function texSlot(list, srgb = true) {
  const key = list[0];
  let e = texReg.get(key);
  if (e) return e;
  e = { key, list, srgb, u: { value: null }, level: 0, preview: null, low: null, hd: null, listeners: [] };
  const data = PREVIEWS[key];
  if (data) {
    const img = new Image();
    const t = prepTex(new THREE.Texture(img), srgb);
    previewPromises.push(new Promise((res) => {
      img.onload = () => { t.needsUpdate = true; res(); };
      img.onerror = () => res();
    }));
    img.src = data;
    e.u.value = e.preview = t;
    if (key.endsWith('.png')) e.level = 1;    // кольца Сатурна: превью и есть полная текстура
  } else {
    const t = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    t.needsUpdate = true;
    e.u.value = e.preview = t;
  }
  texReg.set(key, e);
  return e;
}
function setTex(e, t) {
  e.u.value = t;
  for (const f of e.listeners) f(t);
}

// Передача на видеокарту: пустая текстура нужного размера, затем куски по 1024×1024
// (texSubImage2D) в пределах 2 мс за кадр, в конце — mipmap-уровни одним вызовом.
const TILE = 1024;
const uploads = [];
const _region = new THREE.Box2(), _pos = new THREE.Vector2();
function queueUpload(bitmap, srgb, apply) {
  const dst = prepTex(new THREE.DataTexture(null, bitmap.width, bitmap.height), srgb);
  dst.magFilter = THREE.LinearFilter;
  dst.minFilter = THREE.LinearMipmapLinearFilter;
  dst.generateMipmaps = true;
  dst.source.dataReady = false;       // только выделить память, данных пока нет
  dst.needsUpdate = true;
  uploads.push({ src: new THREE.Texture(bitmap), dst, bitmap, apply, x: 0, y: 0, started: false });
}
function processUploads() {
  if (!uploads.length) return;
  quality.skip = Math.max(quality.skip, 2);
  const t0 = performance.now();
  while (uploads.length && performance.now() - t0 < 2) {
    const j = uploads[0];
    if (!j.started) {
      renderer.initTexture(j.dst);
      j.dst.generateMipmaps = false;  // иначе mipmap пересчитывался бы после каждого куска
      j.started = true;
      continue;
    }
    const w = Math.min(TILE, j.bitmap.width - j.x), h = Math.min(TILE, j.bitmap.height - j.y);
    _region.min.set(j.x, j.y);
    _region.max.set(j.x + w, j.y + h);
    _pos.set(j.x, j.y);
    renderer.copyTextureToTexture(j.src, j.dst, _region, _pos);
    j.x += TILE;
    if (j.x >= j.bitmap.width) { j.x = 0; j.y += TILE; }
    if (j.y < j.bitmap.height) continue;
    const gl = renderer.getContext();
    renderer.state.bindTexture(gl.TEXTURE_2D, renderer.properties.get(j.dst).__webglTexture);
    gl.generateMipmap(gl.TEXTURE_2D);
    renderer.state.unbindTexture();
    j.dst.generateMipmaps = true;
    j.bitmap.close?.();
    uploads.shift();
    j.apply(j.dst);
  }
}

// ---------------------------------------------------------------- Солнечный «свет» для шейдеров
const sunView = new THREE.Vector3();
const sharedUniforms = { uSunView: { value: sunView }, uLight: { value: LIGHT } };

// ---------------------------------------------------------------- Фон — Млечный Путь
// Текстура в галактических координатах: ориентируем по галактическому полюсу и центру.
const skyTex = texSlot(['web/2k_stars_milky_way.webp', 'web/8k_stars_milky_way.webp']);
const sky = (() => {
  const gnp = eqToScene(radec(192.85948, 27.12825)).normalize();
  const gc = eqToScene(radec(266.40510, -28.936175)).normalize();
  const z = new THREE.Vector3().crossVectors(gnp, gc).normalize();
  const x = gc.clone().negate();
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(1, 96, 48),
    new THREE.MeshBasicMaterial({ map: skyTex.u.value, color: new THREE.Color(0.38, 0.38, 0.4), side: THREE.DoubleSide, depthWrite: false, depthTest: false }),
  );
  m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, gnp, z));
  m.scale.set(-1e9, 1e9, 1e9);
  m.renderOrder = -10;
  m.frustumCulled = false;
  scene.add(m);
  return m;
})();
skyTex.listeners.push((t) => { sky.material.map = t; });

// ---------------------------------------------------------------- Тела
const bodies = [];
const byId = {};

// Кто кого может затенять: спутники — свою планету (до 4 крупнейших), планета — свои спутники
const childrenOf = {};
for (const d of BODIES) if (d.parent) (childrenOf[d.parent] ||= []).push(d);
function occluderIds(def) {
  const kids = (childrenOf[def.id] || []).slice().sort((a, b) => b.radius - a.radius).slice(0, 4).map((k) => k.id);
  return def.parent ? [...kids, def.parent] : kids;
}
function occlusionUniforms(n) {
  return {
    uOcc: { value: Array.from({ length: Math.max(n, 1) }, () => new THREE.Vector4()) },
    uOccRes: { value: Array.from({ length: Math.max(n, 1) }, () => new THREE.Vector3()) },
    uSunAng: { value: 0.005 },
  };
}

function makePlanetMaterial(b) {
  const defines = { OCC_N: b.occIds.length };
  const uniforms = {
    ...sharedUniforms,
    ...b.occU,
    map: texSlot(b.tex.map).u,
    uTint: { value: new THREE.Vector3(...(b.tint || [1, 1, 1])) },
    uAmbient: { value: AMBIENT },
    uBump: { value: 0 },
    uSmooth: { value: b.smooth ?? (b.airless ? 0 : 1) },
  };
  if (b.airless) defines.AIRLESS = '';
  if (b.earth) {
    defines.EARTH = '';
    uniforms.nightMap = texSlot(b.tex.night).u;
    uniforms.cloudMap = texSlot(b.tex.clouds, false).u;
    uniforms.normalMap = texSlot(b.tex.normal, false).u;
    uniforms.specMap = texSlot(b.tex.spec, false).u;
    uniforms.uCloudShift = { value: 0 };
  }
  if (b.atmo) {
    defines.ATMO = '';
    uniforms.uAtmoColor = { value: new THREE.Vector3(...b.atmo.color) };
    uniforms.uSunsetColor = { value: new THREE.Vector3(...b.atmo.sunset) };
    uniforms.uHaze = { value: b.atmo.haze };
  }
  if (b.rings) {
    defines.RING_SHADOW = '';
    uniforms.ringMap = texSlot(b.tex.ring).u;
    uniforms.uCenterView = { value: new THREE.Vector3() };
    uniforms.uRingNormalView = { value: new THREE.Vector3() };
    uniforms.uRingRadii = { value: new THREE.Vector2() };
  }
  return new THREE.ShaderMaterial({ vertexShader: S.planetVert, fragmentShader: S.planetFrag, uniforms, defines });
}

for (const def of BODIES) {
  const b = { ...def, parentBody: null, moons: [] };
  b.group = new THREE.Group();          // положение
  b.frame = new THREE.Group();          // ориентация экватора
  b.group.add(b.frame);
  scene.add(b.group);
  b.posKm = new THREE.Vector3();        // гелиоцентрическое
  b.relKm = new THREE.Vector3();        // относительно родителя
  b.visR = visRadius(b.radius, b.id);
  b.r = b.visR;
  b.occIds = b.id === 'sun' ? [] : occluderIds(def);
  b.occU = occlusionUniforms(b.occIds.length);
  const eqR = b.equatorial || b.radius;
  const small = b.type === 'moon' && b.radius < 100;
  const geo = new THREE.SphereGeometry(1, small ? 64 : 160, small ? 32 : 80);

  if (b.id === 'sun') {
    b.material = new THREE.ShaderMaterial({
      vertexShader: S.sunVert, fragmentShader: S.sunFrag,
      uniforms: { map: texSlot(b.tex.map).u, uTime: { value: 0 }, uIntensity: { value: 2.9 } },
    });
  } else {
    b.material = makePlanetMaterial(b);
  }
  b.mesh = new THREE.Mesh(geo, b.material);
  // Сплюснутость у полюсов; Фобос и Деймос — трёхосные эллипсоиды (длинная ось к Марсу)
  if (b.shape) b.mesh.scale.set(b.shape[0] / b.radius, b.shape[1] / b.radius, b.shape[2] / b.radius);
  else b.mesh.scale.set(1, 1 - (b.flattening || 0), 1);
  b.spin = new THREE.Group();
  b.spin.add(b.mesh);
  b.frame.add(b.spin);

  if (b.pole) b.frame.quaternion.copy(poleFrame(b.pole[0], b.pole[1]));

  if (b.earth) {
    b.clouds = new THREE.Mesh(new THREE.SphereGeometry(1.006, 160, 80), new THREE.ShaderMaterial({
      vertexShader: S.planetVert, fragmentShader: S.cloudFrag, transparent: true, depthWrite: false,
      defines: { OCC_N: b.occIds.length },
      uniforms: { ...sharedUniforms, ...b.occU, map: texSlot(b.tex.clouds, false).u },
    }));
    b.clouds.scale.y = 1 - b.flattening;
    b.frame.add(b.clouds);
  }

  if (b.atmo) {
    const h = b.atmo.height;
    b.atmoMat = new THREE.ShaderMaterial({
      vertexShader: S.atmoVert, fragmentShader: S.atmoFrag, side: THREE.BackSide,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: {
        ...sharedUniforms,
        uCenterView: { value: new THREE.Vector3() }, uColor: { value: new THREE.Vector3(...b.atmo.color) },
        uSunsetColor: { value: new THREE.Vector3(...b.atmo.sunset) }, uR: { value: 1 }, uRa: { value: 1 + h },
        uStrength: { value: b.atmo.strength },
      },
    });
    b.atmoMesh = new THREE.Mesh(new THREE.SphereGeometry(1 + h, 96, 48), b.atmoMat);
    b.frame.add(b.atmoMesh);
  }

  if (b.rings) {
    const inner = b.rings.inner / eqR, outer = b.rings.outer / eqR;
    b.ringMat = new THREE.ShaderMaterial({
      vertexShader: S.ringVert, fragmentShader: S.ringFrag, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: {
        ...sharedUniforms, map: texSlot(b.tex.ring).u, uRadii: { value: new THREE.Vector2(inner, outer) },
        uCenterView: { value: new THREE.Vector3() }, uNormalView: { value: new THREE.Vector3() }, uPlanetR: { value: 1 },
      },
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 512, 1), b.ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 2;
    b.frame.add(ring);
  }

  // Точка, видимая когда тело меньше пикселя (реальный масштаб)
  const ptGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  b.point = new THREE.Points(ptGeo, new THREE.PointsMaterial({
    color: new THREE.Color(b.color || '#bbbbbb'), size: b.type === 'moon' ? 2 : 3, sizeAttenuation: false, transparent: true, depthWrite: false,
  }));
  b.point.visible = false;
  b.group.add(b.point);

  // Подпись
  const el = document.createElement('div');
  el.className = 'label' + (b.type === 'moon' ? ' moon' : '');
  el.innerHTML = `<span>${b.name}</span>`;
  el.addEventListener('click', (e) => { e.stopPropagation(); focusBody(b); });
  el.addEventListener('pointerenter', () => el.classList.add('hover'));
  el.addEventListener('pointerleave', () => el.classList.remove('hover'));
  b.labelEl = el;
  b.label = new CSS2DObject(el);
  b.group.add(b.label);

  bodies.push(b);
  byId[b.id] = b;
}
for (const b of bodies) if (b.parent) { b.parentBody = byId[b.parent]; b.parentBody.moons.push(b); }
for (const b of bodies) {
  b.occluders = b.occIds.map((id) => byId[id]);
  // В тени Земли остаётся красный свет, преломлённый её атмосферой
  b.occluders.forEach((o, k) => b.occU.uOccRes.value[k].set(...(o.earth ? [0.32, 0.1, 0.035] : [0, 0, 0])));
}

// ---------------------------------------------------------------- Корона
const sun = byId.sun;
const coronaMat = new THREE.ShaderMaterial({
  vertexShader: S.coronaVert, fragmentShader: S.coronaFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uTime: { value: 0 }, uSunFrac: { value: 0.25 }, uGlare: { value: 1 } },
});
const corona = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), coronaMat);
corona.renderOrder = 3;
scene.add(corona);

// ---------------------------------------------------------------- Орбиты
const orbitGroup = new THREE.Group();
scene.add(orbitGroup);
const ORBIT_N = 720;
for (const b of bodies) {
  if (!b.orbit && !b.parent) continue;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((ORBIT_N + 1) * 3), 3));
  const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(b.color || '#8899aa'), transparent: true, opacity: b.parent ? 0.22 : 0.3, depthWrite: false });
  b.orbitLine = new THREE.Line(geo, mat);
  b.orbitLine.frustumCulled = false;
  orbitGroup.add(b.orbitLine);
}
const _v = new THREE.Vector3();
const moonScale = (b, km) => lmix(visMoonDist(km, b.parentBody.radius, b.parentBody.visR), km / 1000, scaleT);
function updateOrbitLine(b, d) {
  const arr = b.orbitLine.geometry.attributes.position.array;
  const el = b.orbit ? planetElements(b.orbit, d) : b.moonOrbit === 'luna' ? lunaElements(d) : null;
  const plane = b.orbitFrame === 'own' ? b.frame.quaternion : b.parentBody?.frame.quaternion;
  for (let k = 0; k <= ORBIT_N; k++) {
    const E = (k / ORBIT_N) * Math.PI * 2;
    if (b.orbit) {
      orbitalToEcl(el.a * AU_KM, el.e, el.i, el.O, el.w, E, _v);
      _v.setLength(heliScale(_v.length()));
    } else if (b.moonOrbit === 'luna') {
      orbitalToEcl(384400, el.e, el.i, el.O, el.w, E, _v);
      _v.setLength(moonScale(b, _v.length()));
    } else {
      _v.set(Math.cos(E), 0, -Math.sin(E)).applyQuaternion(plane).multiplyScalar(moonScale(b, b.a));
    }
    arr[k * 3] = _v.x; arr[k * 3 + 1] = _v.y; arr[k * 3 + 2] = _v.z;
  }
  b.orbitLine.geometry.attributes.position.needsUpdate = true;
}

// ---------------------------------------------------------------- Пояс астероидов и пояс Койпера
// Элементы орбит лежат в атрибутах, а движение по Кеплеру считает вершинный шейдер —
// процессор не тратит на 9 000 тел ни такта.
function makeBelt(n, aMin, aMax, eMax, iMax, color, bright) {
  const orbit = new Float32Array(n * 4), phase = new Float32Array(n * 4), col = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let k = 0; k < n; k++) {
    const a = aMin + (aMax - aMin) * (0.5 + (Math.random() + Math.random() + Math.random() - 1.5) / 3);
    orbit.set([a, Math.random() * eMax, Math.abs(THREE.MathUtils.randFloatSpread(1) * Math.random()) * iMax * DEG, Math.random() * Math.PI * 2], k * 4);
    phase.set([Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, (2 * Math.PI) / (365.25636 * Math.pow(a, 1.5)), bright * (0.6 + Math.random() * 0.6)], k * 4);
    c.set(color).offsetHSL(0, 0, (Math.random() - 0.5) * 0.15);
    col.set([c.r, c.g, c.b], k * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aOrbit', new THREE.BufferAttribute(orbit, 4));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 4));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.ShaderMaterial({
    vertexShader: S.beltVert, fragmentShader: S.beltFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uDays: { value: 0 }, uScaleT: { value: 0 }, uSize: { value: BELT_PX * quality.pr } },
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  scene.add(pts);
  belts.push({ pts, mat });
}
makeBelt(5000, 2.15, 3.3, 0.18, 16, '#a39584', 0.42);
makeBelt(4000, 39, 48, 0.2, 22, '#8fa3b5', 0.38);

// ---------------------------------------------------------------- Положения тел
function updateBodies(d) {
  for (const b of bodies) {
    b.r = lmix(b.visR, b.radius / 1000, scaleT);
    b.frame.scale.setScalar(b.r);
    if (b.orbit) {
      planetPosKm(b, d, b.posKm);
      b.group.position.copy(b.posKm).setLength(heliScale(b.posKm.length()));
    }
  }
  // Суточное вращение (IAU): угол нулевого меридиана W. Синхронные тела — всегда по точному времени.
  for (const b of bodies) {
    if (b.Wdot === undefined) continue;
    const t = b.locked ? d : spinD;
    b.W = ((b.W0 + b.Wdot * t) % 360) * DEG;
    b.spin.rotation.y = b.W;
  }
  for (const b of bodies) {
    if (!b.parentBody) continue;
    const p = b.parentBody;
    if (b.moonOrbit === 'luna') {
      lunaPosKm(d, b.relKm);
    } else if (b.orbitFrame === 'own') {
      // Тритон: орбита в плоскости своего экватора, нулевой меридиан смотрит на Нептун
      const th = b.W + Math.PI;
      b.relKm.set(Math.cos(th), 0, -Math.sin(th)).applyQuaternion(b.frame.quaternion).multiplyScalar(b.a);
    } else {
      const th = (b.L0 + (360 / b.period) * d) * DEG;
      b.relKm.set(Math.cos(th), 0, -Math.sin(th)).applyQuaternion(p.frame.quaternion).multiplyScalar(b.a);
      // Приливный захват: нулевой меридиан смотрит на планету
      b.frame.quaternion.copy(p.frame.quaternion);
      b.spin.rotation.y = th + Math.PI;
    }
    b.posKm.copy(p.posKm).add(b.relKm);
    b.group.position.copy(b.relKm).setLength(moonScale(b, b.relKm.length())).add(p.group.position);
    b.orbitLine.position.copy(p.group.position);
  }
  const earth = byId.earth;
  // Облака дрейфуют относительно поверхности
  const cloudShift = ((spinD * 0.9) % 360) / 360;
  earth.clouds.rotation.y = earth.spin.rotation.y + cloudShift * Math.PI * 2;
  earth.material.uniforms.uCloudShift.value = cloudShift;
  for (const { mat } of belts) { mat.uniforms.uDays.value = d; mat.uniforms.uScaleT.value = scaleT; }
}

// Обновление зависящих от камеры униформ (view space)
const _m3 = new THREE.Matrix3();
const _n = new THREE.Vector3();
const _c = new THREE.Vector3();
function updateViewUniforms() {
  camera.updateMatrixWorld();
  const view = camera.matrixWorldInverse;
  sunView.set(0, 0, 0).applyMatrix4(view);
  _m3.setFromMatrix4(view);
  for (const b of bodies) {
    if (b.atmoMat) {
      b.atmoMat.uniforms.uCenterView.value.copy(b.group.position).applyMatrix4(view);
      b.atmoMat.uniforms.uR.value = b.r;
      b.atmoMat.uniforms.uRa.value = b.r * (1 + b.atmo.height);
    }
    if (b.ringMat) {
      _c.copy(b.group.position).applyMatrix4(view);
      _n.set(0, 1, 0).applyQuaternion(b.frame.quaternion).applyMatrix3(_m3).normalize();
      const eqR = b.equatorial || b.radius;
      b.ringMat.uniforms.uCenterView.value.copy(_c);
      b.ringMat.uniforms.uNormalView.value.copy(_n);
      b.ringMat.uniforms.uPlanetR.value = b.r * eqR / b.radius;
      const u = b.material.uniforms;
      u.uCenterView.value.copy(_c);
      u.uRingNormalView.value.copy(_n);
      u.uRingRadii.value.set(b.rings.inner / b.radius * b.r, b.rings.outer / b.radius * b.r);
    }
    if (b.occluders.length) {
      b.occU.uSunAng.value = SUN_R_KM / Math.max(b.posKm.length(), 1e6);
      b.occluders.forEach((o, k) => {
        const v = b.occU.uOcc.value[k];
        _c.copy(o.group.position).applyMatrix4(view);
        v.set(_c.x, _c.y, _c.z, o.r);
      });
    }
    if (b.material.uniforms.uBump) b.material.uniforms.uBump.value = (b.bump || 0) * b.r * 0.012;
  }
}

// ---------------------------------------------------------------- Камера: фокус и перелёт
let focus = null;
let flight = null;
const prevFocusPos = new THREE.Vector3();

function viewDistance(b) {
  if (b.id === 'sun') return b.r * 5;
  if (b.rings) return b.r * 7;
  return b.r * 5;
}
function overviewDistance() { return heliScale(31 * AU_KM) * 1.35; }

function focusBody(b) {
  if (!b) return goOverview();
  const bodyPos = b.group.position.clone();
  const toCam = camera.position.clone().sub(bodyPos).normalize();
  let dir;
  if (b.id === 'sun') dir = toCam;
  else {
    // Смотрим преимущественно на дневную сторону, чуть сверху
    const toSun = bodyPos.clone().negate().normalize();
    dir = toCam.clone().lerp(toSun, 0.65).add(new THREE.Vector3(0, 0.22, 0)).normalize();
  }
  flight = {
    body: b, t0: performance.now(), dur: 2400,
    fromTarget: controls.target.clone(), fromDir: camera.position.clone().sub(controls.target).normalize(),
    fromDist: camera.position.distanceTo(controls.target), toDir: dir,
  };
  focus = b;
  controls.minDistance = b.r * 1.05;
  showCard(b);
  updateListActive();
  // Выгружаем лишние 8K сразу, а новые грузим после перелёта — чтобы он шёл плавно
  requestHD(null, b);
}

function goOverview() {
  focus = null;
  const dir = new THREE.Vector3(0, 0.45, 1).normalize();
  flight = {
    body: null, t0: performance.now(), dur: 2200,
    fromTarget: controls.target.clone(), fromDir: camera.position.clone().sub(controls.target).normalize(),
    fromDist: camera.position.distanceTo(controls.target), toDir: dir,
  };
  controls.minDistance = sun.r * 1.2;
  hideCard();
  updateListActive();
  requestHD(null);
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _target = new THREE.Vector3(), _dir = new THREE.Vector3(), ORIGIN = new THREE.Vector3();
function updateCamera(now) {
  if (flight) {
    const k = Math.min((now - flight.t0) / flight.dur, 1);
    const e = ease(k);
    const toTarget = flight.body ? flight.body.group.position : ORIGIN;
    const toDist = flight.body ? viewDistance(flight.body) : overviewDistance();
    _target.copy(flight.fromTarget).lerp(toTarget, e);
    _q1.setFromUnitVectors(flight.fromDir, flight.toDir);
    _q2.identity().slerp(_q1, e);
    _dir.copy(flight.fromDir).applyQuaternion(_q2);
    controls.target.copy(_target);
    camera.position.copy(_target).addScaledVector(_dir, lmix(flight.fromDist, toDist, e));
    if (k >= 1) {
      if (flight.body) requestHD(flight.body);
      flight = null;
    }
  } else if (focus) {
    // Следуем за телом
    camera.position.add(_v.copy(focus.group.position).sub(prevFocusPos));
    controls.target.copy(focus.group.position);
  }
  if (focus) prevFocusPos.copy(focus.group.position);
}

// ---------------------------------------------------------------- Переключение масштаба
function setScale(real) {
  scaleTarget = real ? 1 : 0;
  document.getElementById('btnScale').setAttribute('aria-pressed', String(real));
}
function stepScale(dt) {
  if (scaleT === scaleTarget) return false;
  const beforeR = focus ? focus.r : overviewDistance();
  const sign = Math.sign(scaleTarget - scaleT);
  scaleT = THREE.MathUtils.clamp(scaleT + sign * dt / 2.5, 0, 1);
  if ((sign > 0 && scaleT >= scaleTarget) || (sign < 0 && scaleT <= scaleTarget)) scaleT = scaleTarget;
  return beforeR;
}

// ---------------------------------------------------------------- Фоновая загрузка полноразмерных текстур
const hdStatus = document.getElementById('hdStatus');
let bgTotal = 0, bgDone = 0, hdPending = 0;
function updateStatus() {
  if (bgDone < bgTotal) {
    hdStatus.textContent = `Загрузка текстур… ${Math.round((bgDone / bgTotal) * 100)}%`;
    hdStatus.classList.add('show');
  } else if (hdPending > 0) {
    hdStatus.textContent = 'Загрузка текстур высокого разрешения…';
    hdStatus.classList.add('show');
  } else hdStatus.classList.remove('show');
}

async function loadFullTextures() {
  // Порядок важности: небо, Солнце, планеты, затем дополнительные карты Земли и спутники
  const order = [...texReg.values()].filter((e) => e.level === 0);
  const rank = (e) => (e === skyTex ? 0 : e.key.includes('sun') ? 1 : e.key.includes('moons/') ? 4 : e.key.includes('earth_') && !e.key.includes('daymap') ? 3 : 2);
  order.sort((a, b) => rank(a) - rank(b));
  bgTotal = order.length;
  updateStatus();
  let next = 0;
  const done = () => { bgDone++; updateStatus(); if (bgDone === bgTotal && hdEnabled) setSkyHD(true); };
  // Скачивание и декодирование идут параллельно и не ждут кадров; в кадре — только загрузка на видеокарту
  const worker = async () => {
    while (next < order.length) {
      const e = order[next++];
      try {
        const bmp = await loadBitmap(e.key);
        queueUpload(bmp, e.srgb, (t) => {
          e.low = t; e.level = 1;
          if (!e.hd) setTex(e, t);
          if (e.preview) { e.preview.dispose(); e.preview = null; }
          done();
        });
      } catch (err) {
        console.warn('Не загрузилась текстура', e.key, err);
        done();
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

// ---------------------------------------------------------------- HD-текстуры для выбранного тела
const hdActive = new Set();   // записи texReg, у которых сейчас HD
let hdEnabled = canHD;

function hdEntries(b) {
  const lists = [b.tex.map, b.tex.night, b.tex.clouds].filter((l) => l && l.length > 1);
  return lists.map((l) => texReg.get(l[0])).filter(Boolean);
}
function dropHD(e) {
  hdActive.delete(e);           // незавершённая загрузка увидит это и не применит текстуру
  if (!e.hd) return;
  const hd = e.hd;
  e.hd = null;
  setTex(e, e.low || e.preview);
  hd.dispose();
}

// b — тело, для которого грузим 8K; keepFor — тело, чьи текстуры пока не выгружаем (идёт перелёт к нему)
async function requestHD(b, keepFor = b) {
  const keepBodies = [];
  if (keepFor && hdEnabled) keepBodies.push(keepFor, ...(keepFor.parentBody ? [keepFor.parentBody] : []), ...keepFor.moons);
  const keep = new Set(keepBodies.flatMap(hdEntries));
  for (const e of [...hdActive]) if (!keep.has(e)) dropHD(e);
  if (!b || !hdEnabled) return;
  const wanted = [b, ...(b.parentBody ? [b.parentBody] : []), ...b.moons].flatMap(hdEntries).filter((e) => !hdActive.has(e));
  for (const e of wanted) hdActive.add(e);
  hdPending += wanted.length;
  updateStatus();
  // По одной: 8K-картинка декодируется ≈0,2 с на ядро, четыре сразу отнимали бы процессор у анимации.
  // Первой идёт текстура самого выбранного тела.
  for (const e of wanted) {
    try {
      if (!hdActive.has(e)) continue;                   // фокус уже сменился
      const bmp = await loadBitmap(e.list[1]);
      if (!hdActive.has(e)) { bmp.close?.(); continue; }
      queueUpload(bmp, e.srgb, (t) => {
        if (!hdActive.has(e)) { t.dispose(); return; }
        const prev = e.hd;
        e.hd = t;
        setTex(e, t);
        prev?.dispose();          // быстрый повторный выбор того же тела: старая копия не нужна
      });
    } catch (err) {
      hdActive.delete(e);
      console.warn('HD недоступна', e.list[1], err);
    } finally {
      hdPending--;
      updateStatus();
    }
  }
}

// Небо в 8K загружаем один раз, после остальных текстур
let skyHD = null;
function setSkyHD(on) {
  if (on && !skyHD) {
    loadBitmap(skyTex.list[1]).then((bmp) => queueUpload(bmp, true, (t) => {
      skyHD = t;
      if (hdEnabled) sky.material.map = t;
    })).catch(() => {});
  } else if (skyHD) {
    sky.material.map = on ? skyHD : skyTex.u.value;
  }
}

// ---------------------------------------------------------------- UI
const $ = (id) => document.getElementById(id);
const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

function buildList() {
  const nav = $('bodies');
  for (const b of bodies) {
    if (b.parentBody) continue;
    const add = (x) => {
      const btn = document.createElement('button');
      btn.className = x.type === 'moon' ? 'moon' : '';
      const c = x.id === 'sun' ? '#ffd27a' : x.color || '#bbb';
      btn.innerHTML = `<span class="dot" style="color:${c};background:${c}"></span>${x.name}`;
      btn.addEventListener('click', () => focusBody(x));
      x.listBtn = btn;
      nav.appendChild(btn);
    };
    add(b);
    b.moons.forEach(add);
  }
}
function updateListActive() {
  for (const b of bodies) b.listBtn?.classList.toggle('active', b === focus);
}

const TYPE_NAMES = { star: 'Звезда', planet: 'Планета', dwarf: 'Карликовая планета', moon: 'Спутник' };
function showCard(b) {
  $('cardType').textContent = b.parentBody ? `Спутник · ${b.parentBody.name}` : TYPE_NAMES[b.type];
  $('cardName').textContent = b.name;
  $('cardDesc').textContent = b.desc;
  const dl = $('cardFacts');
  dl.innerHTML = '';
  if (b.id !== 'sun') {
    const live = document.createElement('dt');
    live.textContent = b.parentBody ? `До ${b.parentBody.gen || 'планеты'}` : 'От Солнца';
    const dd = document.createElement('dd');
    dd.className = 'live';
    dd.id = 'liveDist';
    dl.append(live, dd);
  }
  for (const [k, v] of Object.entries(b.facts)) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }
  $('card').classList.remove('hidden');
}
function hideCard() { $('card').classList.add('hidden'); }

const nf = (n, digits = 0) => n.toLocaleString('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: digits });
function updateLiveCard() {
  const el = document.getElementById('liveDist');
  if (!el || !focus) return;
  if (focus.parentBody) {
    el.textContent = `${nf(focus.relKm.length())} км`;
  } else {
    const km = focus.posKm.length();
    el.textContent = `${nf(km / AU_KM, 3)} а.е. · ${nf(km / 1e6, 1)} млн км`;
  }
}

function updateSpeedUI() {
  $('speed').value = speedIdx;
  $('speedLabel').textContent = (reverse ? '− ' : '') + SPEED_LABELS[speedIdx];
  $('btnPause').textContent = paused ? '▶' : '❚❚';
  $('btnReverse').setAttribute('aria-pressed', String(reverse));
}

function toggle(btn, fn) {
  btn.addEventListener('click', () => {
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    fn(on);
  });
}

let labelsOn = true;
toggle($('btnOrbits'), (on) => { orbitGroup.visible = on; });
toggle($('btnLabels'), (on) => { labelsOn = on; });
$('btnScale').addEventListener('click', () => setScale(scaleTarget === 0));
if (!canHD) { $('btnHD').setAttribute('aria-pressed', 'false'); $('btnHD').disabled = true; $('btnHD').title = 'Видеокарта не поддерживает текстуры 8K'; }
toggle($('btnHD'), (on) => { hdEnabled = on && canHD; requestHD(flight ? null : focus, focus); setSkyHD(hdEnabled); });
$('btnOverview').addEventListener('click', goOverview);
$('cardClose').addEventListener('click', goOverview);
$('speed').addEventListener('input', (e) => { speedIdx = +e.target.value; updateSpeedUI(); });
$('btnPause').addEventListener('click', () => { paused = !paused; updateSpeedUI(); });
$('btnReverse').addEventListener('click', () => { reverse = !reverse; updateSpeedUI(); });
$('btnNow').addEventListener('click', () => { simTime = Date.now(); speedIdx = 0; reverse = false; paused = false; updateSpeedUI(); });
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.code !== 'Space' && e.code !== 'Escape') return;
  if (e.code === 'Space') { e.preventDefault(); paused = !paused; updateSpeedUI(); }
  if (e.code === 'Escape') goOverview();
});

// ---------------------------------------------------------------- Выбор мышью (в экранном пространстве)
const pointer = { x: 0, y: 0, downX: 0, downY: 0, inside: false };
const _s = new THREE.Vector3();
function screenInfo(b, out) {
  _s.copy(b.group.position).project(camera);
  if (_s.z > 1 || _s.z < -1) return null;
  out.x = (_s.x * 0.5 + 0.5) * innerWidth;
  out.y = (-_s.y * 0.5 + 0.5) * innerHeight;
  out.dist = camera.position.distanceTo(b.group.position);
  out.rpx = (b.r / (out.dist * Math.tan((camera.fov * DEG) / 2))) * (innerHeight / 2);
  return out;
}
const _si = { x: 0, y: 0, rpx: 0, dist: 0 };
function pick(px, py) {
  let best = null, bestScore = Infinity;
  for (const b of bodies) {
    const s = screenInfo(b, _si);
    if (!s) continue;
    const d = Math.hypot(s.x - px, s.y - py);
    const reach = Math.max(s.rpx, 14);
    if (d > reach) continue;
    // Попадание по диску — приоритет ближнему телу; иначе — ближайшее по экрану
    const score = d < s.rpx ? s.dist * 1e-12 : 1 + d;
    if (score < bestScore) { bestScore = score; best = b; }
  }
  return best;
}
renderer.domElement.addEventListener('pointerdown', (e) => { pointer.downX = e.clientX; pointer.downY = e.clientY; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (Math.hypot(e.clientX - pointer.downX, e.clientY - pointer.downY) > 5 || e.button !== 0) return;
  const b = pick(e.clientX, e.clientY);
  if (b) focusBody(b);
});
renderer.domElement.addEventListener('pointermove', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.inside = true; });
renderer.domElement.addEventListener('pointerleave', () => { pointer.inside = false; });

// ---------------------------------------------------------------- Подписи и точки
const _ps = { x: 0, y: 0, rpx: 0, dist: 0 };
let hovered = null;
function updateLabelsAndPoints() {
  const hover = pointer.inside && !flight ? pick(pointer.x, pointer.y) : null;
  if (hover !== hovered) {
    hovered?.labelEl.classList.remove('hover');
    hover?.labelEl.classList.add('hover');
    renderer.domElement.style.cursor = hover ? 'pointer' : '';
    hovered = hover;
  }
  for (const b of bodies) {
    const s = screenInfo(b, _si);
    let show = labelsOn && !!s && b !== focus && s.rpx <= 40;
    if (show && b.parentBody) {
      const ps = screenInfo(b.parentBody, _ps);
      show = !!ps && Math.hypot(ps.x - s.x, ps.y - s.y) > 28 + ps.rpx;
    }
    b.label.visible = show;
    b.point.visible = !!s && s.rpx < 1.2 && b.id !== 'sun' && scaleT > 0.5;
  }
}

// ---------------------------------------------------------------- Цикл
let last = performance.now();
let lastOrbitScale = -1, lastLunaLine = -Infinity, lastUiUpdate = 0;
const _beforeTarget = new THREE.Vector3(), _off = new THREE.Vector3();

function frame(now) {
  const dtMs = now - last;
  last = now;
  const dt = Math.min(dtMs / 1000, 0.1);
  tuneQuality(dtMs, now);
  processUploads();

  if (!paused) simTime += dt * 1000 * SPEEDS[speedIdx] * (reverse ? -1 : 1);
  const d = daysJ2000(simTime);
  const rate = paused ? 0 : SPEEDS[speedIdx] / 86400;
  spinD = rate <= SPIN_MAX_RATE ? d : spinD + dt * SPIN_MAX_RATE * (reverse ? -1 : 1);

  // Масштаб: при переходе сохраняем относительное положение камеры
  const before = stepScale(dt);
  _beforeTarget.copy(controls.target);
  updateBodies(d);
  if (before !== false) {
    const k = (focus ? focus.r : overviewDistance()) / before;
    const newTarget = focus ? focus.group.position : ORIGIN;
    _off.copy(camera.position).sub(_beforeTarget).multiplyScalar(k);
    controls.target.copy(newTarget);
    camera.position.copy(newTarget).add(_off);
    controls.minDistance = (focus || sun).r * 1.05;
    if (focus) prevFocusPos.copy(focus.group.position);
    flight = null;
  }
  // Орбиты планет меняются только с масштабом; у Луны поворачивается линия узлов (18,6 года)
  if (lastOrbitScale !== scaleT) {
    for (const b of bodies) if (b.orbitLine) updateOrbitLine(b, d);
    lastOrbitScale = scaleT; lastLunaLine = d;
  } else if (Math.abs(d - lastLunaLine) > 2) {
    updateOrbitLine(byId.moon, d);
    lastLunaLine = d;
  }

  updateCamera(now);
  controls.update();
  camera.near = Math.max(1e-4, (focus ? focus.r : sun.r) * 0.01);
  camera.updateProjectionMatrix();

  // Солнце и корона
  const t = now / 1000;
  sun.material.uniforms.uTime.value = t;
  coronaMat.uniforms.uTime.value = t;
  const half = Math.max(sun.r * 4.5, camera.position.length() * 0.045);
  corona.scale.setScalar(half);
  corona.quaternion.copy(camera.quaternion);
  coronaMat.uniforms.uSunFrac.value = sun.r / half;
  coronaMat.uniforms.uGlare.value = THREE.MathUtils.clamp(1 - (sun.r / half) * 3, 0.15, 1);

  updateViewUniforms();
  updateLabelsAndPoints();
  // Текст в интерфейсе — 10 раз в секунду, а не каждый кадр (лишние перерасчёты вёрстки)
  if (now - lastUiUpdate > 100) {
    lastUiUpdate = now;
    $('date').textContent = dateFmt.format(new Date(simTime));
    updateLiveCard();
  }
  sky.position.copy(camera.position);

  composer.render();
  labelRenderer.render(scene, camera);
  requestAnimationFrame(frame);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  applyQuality(quality.pr);
  bloom.resolution.set(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- Старт
async function start() {
  buildList();
  updateSpeedUI();
  await Promise.all(previewPromises);       // превью встроены в previews.js — это мгновенно
  const d = daysJ2000(simTime);
  updateBodies(d);
  for (const b of bodies) if (b.orbitLine) updateOrbitLine(b, d);
  lastOrbitScale = scaleT; lastLunaLine = d;
  camera.position.copy(new THREE.Vector3(0, 0.45, 1).normalize().multiplyScalar(overviewDistance()));
  controls.minDistance = sun.r * 1.2;
  controls.update();
  updateViewUniforms();
  // Шейдеры компилируются параллельно, не блокируя страницу
  try { await renderer.compileAsync(scene, camera); } catch { /* не критично */ }
  last = performance.now();
  requestAnimationFrame(frame);
  requestAnimationFrame(() => $('loader').classList.add('done'));
  loadFullTextures();
}
start();

// Офлайн и мгновенный повторный запуск: текстуры и код кэшируются service worker'ом
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Доступ из консоли для отладки: __solar.focus('saturn')
window.__solar = { focus: (id) => focusBody(byId[id]), setScale, camera, controls, renderer, THREE, bodies: byId, quality, setSpeed: (i) => { speedIdx = i; updateSpeedUI(); }, setTime: (ms) => { simTime = ms; }, getTime: () => simTime };
