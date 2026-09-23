import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { BODIES, AU_KM } from './data.js';
import * as S from './shaders.js';

const DEG = Math.PI / 180;
const TEX = 'textures/';
const OBLIQUITY = 23.4392911 * DEG;
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
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
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

const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.4, 0.35, 1.2);
composer.addPass(bloom);
composer.addPass(new OutputPass());
composer.setPixelRatio(renderer.getPixelRatio());
composer.setSize(innerWidth, innerHeight);

// ---------------------------------------------------------------- Загрузка текстур
const manager = new THREE.LoadingManager();
const loader = new THREE.TextureLoader(manager);
const loadBar = document.getElementById('loadBar'), loadPct = document.getElementById('loadPct');
manager.onProgress = (_, done, total) => {
  const p = Math.round((done / total) * 100);
  loadBar.style.width = p + '%';
  loadPct.textContent = `Загрузка текстур… ${p}%`;
};

function prepTex(t, srgb = true) {
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = maxAniso;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}
const texCache = new Map();
function tex(file, srgb = true) {
  const key = file + srgb;
  if (!texCache.has(key)) texCache.set(key, prepTex(loader.load(TEX + file), srgb));
  return texCache.get(key);
}
// 8K — декодирование вне основного потока через ImageBitmap
const bitmapLoader = new THREE.ImageBitmapLoader();
bitmapLoader.setOptions({ imageOrientation: 'flipY' });
function loadHD(file) {
  return new Promise((resolve, reject) => bitmapLoader.load(TEX + file, (bmp) => {
    const t = prepTex(new THREE.Texture(bmp));
    t.flipY = false;
    t.needsUpdate = true;
    resolve(t);
  }, undefined, reject));
}

// ---------------------------------------------------------------- Солнечный «свет» для шейдеров
const sunView = new THREE.Vector3();
const sharedUniforms = { uSunView: { value: sunView }, uLight: { value: LIGHT } };

// ---------------------------------------------------------------- Фон — Млечный Путь
// Текстура в галактических координатах: ориентируем по галактическому полюсу и центру.
const sky = (() => {
  const gnp = eqToScene(radec(192.85948, 27.12825)).normalize();
  const gc = eqToScene(radec(266.40510, -28.936175)).normalize();
  const z = new THREE.Vector3().crossVectors(gnp, gc).normalize();
  const x = gc.clone().negate();
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(1, 96, 48),
    new THREE.MeshBasicMaterial({ map: tex('2k_stars_milky_way.jpg'), color: new THREE.Color(0.38, 0.38, 0.4), side: THREE.DoubleSide, depthWrite: false, depthTest: false }),
  );
  m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, gnp, z));
  m.scale.set(-1e9, 1e9, 1e9);
  m.renderOrder = -10;
  m.frustumCulled = false;
  scene.add(m);
  return m;
})();

// ---------------------------------------------------------------- Тела
const bodies = [];
const byId = {};

function makePlanetMaterial(b) {
  const defines = {};
  const uniforms = {
    ...sharedUniforms,
    map: { value: tex(b.tex.map[0]) },
    uTint: { value: new THREE.Vector3(...(b.tint || [1, 1, 1])) },
    uAmbient: { value: AMBIENT },
    uBump: { value: 0 },
    uSmooth: { value: b.smooth ?? (b.airless ? 0 : 1) },
  };
  if (b.airless) defines.AIRLESS = '';
  if (b.earth) {
    defines.EARTH = '';
    uniforms.nightMap = { value: tex(b.tex.night[0]) };
    uniforms.cloudMap = { value: tex(b.tex.clouds[0], false) };
    uniforms.normalMap = { value: tex(b.tex.normal[0], false) };
    uniforms.specMap = { value: tex(b.tex.spec[0], false) };
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
    uniforms.ringMap = { value: tex(b.tex.ring[0]) };
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
  const eqR = b.equatorial || b.radius;
  const geo = new THREE.SphereGeometry(1, b.type === 'moon' && b.radius < 100 ? 48 : 160, b.type === 'moon' && b.radius < 100 ? 24 : 80);

  if (b.id === 'sun') {
    b.material = new THREE.ShaderMaterial({
      vertexShader: S.sunVert, fragmentShader: S.sunFrag,
      uniforms: { map: { value: tex(b.tex.map[0]) }, uTime: { value: 0 }, uIntensity: { value: 3.2 } },
    });
  } else {
    b.material = makePlanetMaterial(b);
  }
  b.mesh = new THREE.Mesh(geo, b.material);
  b.mesh.scale.set(1, 1 - (b.flattening || 0), 1);
  b.spin = new THREE.Group();
  b.spin.add(b.mesh);
  b.frame.add(b.spin);

  if (b.pole) b.frame.quaternion.copy(poleFrame(b.pole[0], b.pole[1]));

  if (b.earth) {
    b.clouds = new THREE.Mesh(new THREE.SphereGeometry(1.006, 160, 80), new THREE.ShaderMaterial({
      vertexShader: S.planetVert, fragmentShader: S.cloudFrag, transparent: true, depthWrite: false,
      uniforms: { ...sharedUniforms, map: { value: tex(b.tex.clouds[0], false) } },
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
        ...sharedUniforms, map: { value: tex(b.tex.ring[0]) }, uRadii: { value: new THREE.Vector2(inner, outer) },
        uCenterView: { value: new THREE.Vector3() }, uNormalView: { value: new THREE.Vector3() }, uPlanetR: { value: 1 },
      },
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 512, 1), b.ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 2;
    b.frame.add(ring);
    b.material.uniforms.uRingRadii.value.set(b.rings.inner, b.rings.outer); // пересчитываются в единицы сцены
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
function updateOrbitLines(d) {
  for (const b of bodies) {
    if (!b.orbitLine) continue;
    const arr = b.orbitLine.geometry.attributes.position.array;
    const el = b.orbit ? planetElements(b.orbit, d) : b.moonOrbit === 'luna' ? lunaElements(d) : null;
    for (let k = 0; k <= ORBIT_N; k++) {
      const E = (k / ORBIT_N) * Math.PI * 2;
      if (b.orbit) {
        orbitalToEcl(el.a * AU_KM, el.e, el.i, el.O, el.w, E, _v);
        _v.setLength(heliScale(_v.length()));
      } else if (b.moonOrbit === 'luna') {
        orbitalToEcl(384400, el.e, el.i, el.O, el.w, E, _v);
        _v.setLength(moonScale(b, _v.length()));
      } else {
        _v.set(Math.cos(E), 0, -Math.sin(E)).applyQuaternion(b.parentBody.frame.quaternion).multiplyScalar(moonScale(b, b.a));
      }
      arr[k * 3] = _v.x; arr[k * 3 + 1] = _v.y; arr[k * 3 + 2] = _v.z;
    }
    b.orbitLine.geometry.attributes.position.needsUpdate = true;
  }
}
const moonScale = (b, km) => lmix(visMoonDist(km, b.parentBody.radius, b.parentBody.visR), km / 1000, scaleT);

// ---------------------------------------------------------------- Пояс астероидов и пояс Койпера
function makeBelt(n, aMin, aMax, eMax, iMax, color, size) {
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const el = [];
  const c = new THREE.Color();
  for (let k = 0; k < n; k++) {
    // Концентрация к середине пояса, «люки Кирквуда» не моделируем
    const a = aMin + (aMax - aMin) * (0.5 + (Math.random() + Math.random() + Math.random() - 1.5) / 3);
    el.push({
      a: a * AU_KM, e: Math.random() * eMax, i: Math.abs(THREE.MathUtils.randFloatSpread(1) * Math.random()) * iMax * DEG,
      O: Math.random() * Math.PI * 2, w: Math.random() * Math.PI * 2, M0: Math.random() * Math.PI * 2,
      n: (2 * Math.PI) / (365.25636 * Math.pow(a, 1.5)),
    });
    c.set(color).offsetHSL(0, 0, (Math.random() - 0.5) * 0.15).multiplyScalar(0.6 + Math.random() * 0.5);
    col.set([c.r, c.g, c.b], k * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false }));
  pts.frustumCulled = false;
  scene.add(pts);
  return { pts, el };
}
const belts = [
  makeBelt(5000, 2.15, 3.3, 0.18, 16, '#a39584', 1.0),
  makeBelt(4000, 39, 48, 0.2, 22, '#8fa3b5', 1.0),
];
function updateBelts(d) {
  for (const { pts, el } of belts) {
    const arr = pts.geometry.attributes.position.array;
    for (let k = 0; k < el.length; k++) {
      const o = el[k];
      const E = solveKepler((o.M0 + o.n * d) % (2 * Math.PI), o.e);
      orbitalToEcl(o.a, o.e, o.i, o.O, o.w, E, _v);
      _v.setLength(heliScale(_v.length()));
      arr[k * 3] = _v.x; arr[k * 3 + 1] = _v.y; arr[k * 3 + 2] = _v.z;
    }
    pts.geometry.attributes.position.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- Положения тел
function updateBodies(d) {
  for (const b of bodies) {
    b.r = lmix(b.visR, b.radius / 1000, scaleT);
    b.group.scale.setScalar(1);
    b.frame.scale.setScalar(b.r);
    if (b.orbit) {
      planetPosKm(b, d, b.posKm);
      b.group.position.copy(b.posKm).setLength(heliScale(b.posKm.length()));
    }
  }
  for (const b of bodies) {
    if (!b.parentBody) continue;
    const p = b.parentBody;
    if (b.moonOrbit === 'luna') {
      lunaPosKm(d, b.relKm);
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
  // Суточное вращение (IAU): угол нулевого меридиана W
  for (const b of bodies) {
    if (b.Wdot === undefined) continue;
    const W = ((b.W0 + b.Wdot * d) % 360) * DEG;
    b.spin.rotation.y = W;
  }
  const earth = byId.earth;
  // Облака дрейфуют относительно поверхности
  const cloudShift = ((d * 0.9) % 360) / 360;
  earth.clouds.rotation.y = earth.spin.rotation.y + cloudShift * Math.PI * 2;
  earth.material.uniforms.uCloudShift.value = cloudShift;
}

// Обновление зависящих от камеры униформ (view space)
const _m3 = new THREE.Matrix3();
function updateViewUniforms() {
  camera.updateMatrixWorld();
  sunView.set(0, 0, 0).applyMatrix4(camera.matrixWorldInverse);
  _m3.setFromMatrix4(camera.matrixWorldInverse);
  for (const b of bodies) {
    if (b.atmoMat) {
      b.group.getWorldPosition(b.atmoMat.uniforms.uCenterView.value).applyMatrix4(camera.matrixWorldInverse);
      // uR/uRa в единицах сцены
      b.atmoMat.uniforms.uR.value = b.r;
      b.atmoMat.uniforms.uRa.value = b.r * (1 + b.atmo.height);
    }
    if (b.ringMat) {
      const c = b.group.position.clone().applyMatrix4(camera.matrixWorldInverse);
      const n = new THREE.Vector3(0, 1, 0).applyQuaternion(b.frame.quaternion).applyMatrix3(_m3).normalize();
      const eqR = b.equatorial || b.radius;
      b.ringMat.uniforms.uCenterView.value.copy(c);
      b.ringMat.uniforms.uNormalView.value.copy(n);
      b.ringMat.uniforms.uPlanetR.value = b.r * eqR / b.radius;
      const u = b.material.uniforms;
      u.uCenterView.value.copy(c);
      u.uRingNormalView.value.copy(n);
      u.uRingRadii.value.set(b.rings.inner / b.radius * b.r, b.rings.outer / b.radius * b.r);
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
  requestHD(b);
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
function updateCamera() {
  if (flight) {
    const k = Math.min((performance.now() - flight.t0) / flight.dur, 1);
    const e = ease(k);
    const toTarget = flight.body ? flight.body.group.position : new THREE.Vector3();
    const toDist = flight.body ? viewDistance(flight.body) : overviewDistance();
    const target = flight.fromTarget.clone().lerp(toTarget, e);
    _q1.setFromUnitVectors(flight.fromDir, flight.toDir);
    _q2.identity().slerp(_q1, e);
    const dir = flight.fromDir.clone().applyQuaternion(_q2);
    const dist = lmix(flight.fromDist, toDist, e);
    controls.target.copy(target);
    camera.position.copy(target).addScaledVector(dir, dist);
    if (k >= 1) flight = null;
  } else if (focus) {
    // Следуем за телом
    const delta = focus.group.position.clone().sub(prevFocusPos);
    camera.position.add(delta);
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

// ---------------------------------------------------------------- HD-текстуры для выбранного тела
const hdActive = new Map();   // body.id -> { uniformName: [texture, lowTexture] }
let hdEnabled = canHD;
const hdStatus = document.getElementById('hdStatus');
let hdPending = 0;

function hdSlots(b) {
  const slots = [];
  const push = (list, uniform, target) => { if (list && list.length > 1) slots.push({ file: list[1], uniform, target }); };
  push(b.tex.map, 'map', b.material);
  if (b.earth) {
    push(b.tex.night, 'nightMap', b.material);
    push(b.tex.clouds, 'cloudMap', b.material);
    push(b.tex.clouds, 'map', b.clouds.material);
  }
  return slots;
}

async function requestHD(b) {
  // Выгружаем 8K у тел, которые больше не в фокусе (экономим видеопамять)
  const keep = new Set();
  if (b && hdEnabled) { keep.add(b.id); if (b.parentBody) keep.add(b.parentBody.id); for (const m of b.moons) keep.add(m.id); }
  for (const [id, entries] of hdActive) {
    if (keep.has(id)) continue;
    for (const e of entries) { e.target.uniforms[e.uniform].value = e.low; e.tex.dispose(); }
    hdActive.delete(id);
  }
  for (const id of keep) {
    const body = byId[id];
    if (hdActive.has(id)) continue;
    const slots = hdSlots(body);
    if (!slots.length) continue;
    hdActive.set(id, []);
    hdPending++;
    hdStatus.classList.add('show');
    const files = [...new Set(slots.map((s) => s.file))];
    try {
      const loaded = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await loadHD(f)])));
      const entries = hdActive.get(id);
      if (!entries) { Object.values(loaded).forEach((t) => t.dispose()); continue; } // фокус уже сменился
      for (const s of slots) {
        const t = loaded[s.file];
        if (s.uniform === 'cloudMap' || (s.target !== body.material && s.uniform === 'map' && body.earth)) t.colorSpace = THREE.NoColorSpace;
        entries.push({ target: s.target, uniform: s.uniform, low: s.target.uniforms[s.uniform].value, tex: t });
        s.target.uniforms[s.uniform].value = t;
      }
    } catch (err) {
      console.warn('8K недоступна для', id, err);
    } finally {
      if (--hdPending === 0) hdStatus.classList.remove('show');
    }
  }
}

// Небо в 8K загружаем один раз
let skyHD = null;
function setSkyHD(on) {
  if (on && !skyHD) {
    loadHD('8k_stars_milky_way.jpg').then((t) => {
      skyHD = t;
      if (hdEnabled) { sky.material.map = t; sky.material.needsUpdate = true; }
    }).catch(() => {});
  } else if (skyHD) {
    sky.material.map = on ? skyHD : tex('2k_stars_milky_way.jpg');
    sky.material.needsUpdate = true;
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
      btn.innerHTML = `<span class="dot" style="color:${x.color || x.tintColor || '#ccc'};background:${x.color || '#ccc'}"></span>${x.name}`;
      if (x.id === 'sun') btn.querySelector('.dot').style.cssText = 'color:#ffd27a;background:#ffd27a';
      if (!x.color) {
        const t = x.tint || [0.8, 0.8, 0.8];
        const c = `rgb(${t.map((v) => Math.min(255, Math.round(v * 190))).join(',')})`;
        btn.querySelector('.dot').style.cssText = `color:${c};background:${c}`;
      }
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

const TYPE_NAMES = { star: 'Звезда', planet: 'Планета', moon: 'Спутник' };
function showCard(b) {
  $('cardType').textContent = b.parentBody ? `Спутник · ${b.parentBody.name}` : TYPE_NAMES[b.type];
  $('cardName').textContent = b.name;
  $('cardDesc').textContent = b.desc;
  const dl = $('cardFacts');
  dl.innerHTML = '';
  const live = document.createElement('dt');
  if (b.id !== 'sun') {
    live.textContent = b.parentBody ? `До ${b.parentBody.name === 'Земля' ? 'Земли' : 'планеты'}` : 'От Солнца';
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
toggle($('btnHD'), (on) => { hdEnabled = on && canHD; requestHD(focus); setSkyHD(hdEnabled); });
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
function screenInfo(b) {
  _v.copy(b.group.position).project(camera);
  if (_v.z > 1 || _v.z < -1) return null;
  const x = (_v.x * 0.5 + 0.5) * innerWidth, y = (-_v.y * 0.5 + 0.5) * innerHeight;
  const dist = camera.position.distanceTo(b.group.position);
  const rpx = (b.r / (dist * Math.tan((camera.fov * DEG) / 2))) * (innerHeight / 2);
  return { x, y, rpx, dist };
}
function pick(px, py) {
  let best = null, bestScore = Infinity;
  for (const b of bodies) {
    const s = screenInfo(b);
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
function updateLabelsAndPoints() {
  let hover = null;
  if (pointer.inside && !flight) hover = pick(pointer.x, pointer.y);
  renderer.domElement.style.cursor = hover ? 'pointer' : '';
  for (const b of bodies) {
    const s = screenInfo(b);
    let show = labelsOn && !!s && b !== focus;
    if (show && s.rpx > 40) show = false;
    if (show && b.parentBody) {
      const ps = screenInfo(b.parentBody);
      show = !!ps && Math.hypot(ps.x - s.x, ps.y - s.y) > 28 + ps.rpx;
    }
    b.label.visible = show;
    b.labelEl.classList.toggle('hover', b === hover);
    b.point.visible = !!s && s.rpx < 1.2 && b.id !== 'sun' && scaleT > 0.5;
  }
}

// ---------------------------------------------------------------- Цикл
const clock = new THREE.Clock();
let lastOrbitUpdate = -Infinity, lastOrbitScale = -1;
let started = false;

function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!paused) simTime += dt * 1000 * SPEEDS[speedIdx] * (reverse ? -1 : 1);
  const d = daysJ2000(simTime);

  // Масштаб: при переходе сохраняем относительное положение камеры
  const before = stepScale(dt);
  const beforeTarget = controls.target.clone();
  updateBodies(d);
  if (before !== false) {
    const after = focus ? focus.r : overviewDistance();
    const k = after / before;
    const newTarget = focus ? focus.group.position : new THREE.Vector3();
    const off = camera.position.clone().sub(beforeTarget).multiplyScalar(k);
    controls.target.copy(newTarget);
    camera.position.copy(newTarget).add(off);
    controls.minDistance = (focus || sun).r * 1.05;
    if (focus) prevFocusPos.copy(focus.group.position);
    if (flight) flight = null;
  }
  if (Math.abs(d - lastOrbitUpdate) > 30 || lastOrbitScale !== scaleT) {
    updateOrbitLines(d);
    lastOrbitUpdate = d; lastOrbitScale = scaleT;
  }
  updateBelts(d);

  updateCamera();
  controls.update();
  camera.near = Math.max(1e-4, (focus ? focus.r : sun.r) * 0.01);
  camera.updateProjectionMatrix();

  // Солнце, корона, блик
  const t = performance.now() / 1000;
  sun.material.uniforms.uTime.value = t;
  coronaMat.uniforms.uTime.value = t;
  const camDist = camera.position.length();
  const half = Math.max(sun.r * 4.5, camDist * 0.045);
  corona.scale.setScalar(half);
  corona.quaternion.copy(camera.quaternion);
  coronaMat.uniforms.uSunFrac.value = sun.r / half;
  coronaMat.uniforms.uGlare.value = THREE.MathUtils.clamp(1 - (sun.r / half) * 3, 0.15, 1);

  updateViewUniforms();
  updateLabelsAndPoints();
  updateLiveCard();

  $('date').textContent = dateFmt.format(new Date(simTime));
  sky.position.copy(camera.position);

  composer.render();
  labelRenderer.render(scene, camera);

  if (!started) {
    started = true;
    $('loader').classList.add('done');
  }
  requestAnimationFrame(frame);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  bloom.resolution.set(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
});

buildList();
updateSpeedUI();
manager.onLoad = () => {
  // Начальный вид — обзор системы
  updateBodies(daysJ2000(simTime));
  const dir = new THREE.Vector3(0, 0.45, 1).normalize();
  camera.position.copy(dir.multiplyScalar(overviewDistance()));
  controls.minDistance = sun.r * 1.2;
  if (hdEnabled) setSkyHD(true);
  requestAnimationFrame(frame);
};
manager.onError = (url) => console.warn('Не загрузилась текстура', url);
if (location.protocol === 'file:') $('error').style.display = 'block';

// Доступ из консоли для отладки: __solar.focus('saturn')
window.__solar = { focus: (id) => focusBody(byId[id]), setScale, camera, controls, bodies: byId, setSpeed: (i) => { speedIdx = i; updateSpeedUI(); } };
