// GLSL-шейдеры. Всё освещение считается в пространстве камеры (view space):
// так нет потери точности float32 даже в режиме реального масштаба (миллионы единиц).

const noise = /* glsl */`
// Simplex 3D noise — Ian McEwan, Ashima Arts (MIT)
vec4 permute(vec4 x){ return mod(((x*34.0)+1.0)*x, 289.0); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0/7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

// ---------- Поверхность планеты / спутника ----------
export const planetVert = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
varying vec3 vViewPos;
varying vec3 vViewNormal;
varying vec3 vViewTangent;
void main(){
  vUv = uv;
  vec3 n = normalize(normal);
  // Касательная «на восток» (направление роста u) и нормаль в пространстве камеры
  vec3 t = cross(vec3(0.0, 1.0, 0.0), n);
  t = length(t) < 1e-4 ? vec3(1.0, 0.0, 0.0) : normalize(t);
  vViewNormal = normalize(normalMatrix * n);
  vViewTangent = normalize(normalMatrix * t);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

export const planetFrag = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D map;
uniform vec3 uTint;
uniform vec3 uSunView;
uniform float uLight;
uniform float uAmbient;
uniform float uBump;
uniform float uSmooth;
#ifdef EARTH
uniform sampler2D nightMap;
uniform sampler2D normalMap;
uniform sampler2D specMap;
uniform sampler2D cloudMap;
uniform float uCloudShift;
#endif
#ifdef RING_SHADOW
uniform sampler2D ringMap;
uniform vec3 uCenterView;
uniform vec3 uRingNormalView;
uniform vec2 uRingRadii;
#endif
#ifdef ATMO
uniform vec3 uAtmoColor;
uniform vec3 uSunsetColor;
uniform float uHaze;
#endif
varying vec2 vUv;
varying vec3 vViewPos;
varying vec3 vViewNormal;
varying vec3 vViewTangent;

float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }

// Рельеф из яркости текстуры (метод Мортена Миккельсена, как в three.js bumpmap)
vec3 bumpNormal(vec3 N){
  vec2 dx = dFdx(vUv), dy = dFdy(vUv);
  if (abs(dx.x) > 0.5 || abs(dy.x) > 0.5) return N; // шов текстуры
  float h0 = lum(texture2D(map, vUv).rgb);
  float dBx = uBump * (lum(texture2D(map, vUv + dx).rgb) - h0);
  float dBy = uBump * (lum(texture2D(map, vUv + dy).rgb) - h0);
  vec3 sx = dFdx(vViewPos), sy = dFdy(vViewPos);
  vec3 r1 = cross(sy, N), r2 = cross(N, sx);
  float det = dot(sx, r1);
  vec3 grad = sign(det) * (dBx * r1 + dBy * r2);
  return normalize(abs(det) * N - grad);
}

void main(){
  #include <logdepthbuf_fragment>
  vec3 Ng = normalize(vViewNormal);
  vec3 N = Ng;
  vec3 V = normalize(-vViewPos);
  vec3 L = normalize(uSunView - vViewPos);
  vec3 albedo = texture2D(map, vUv).rgb * uTint;

#ifdef EARTH
  vec3 T = normalize(vViewTangent - Ng * dot(vViewTangent, Ng));
  vec3 B = cross(Ng, T);
  vec3 nm = texture2D(normalMap, vUv).xyz * 2.0 - 1.0;
  nm.xy *= 0.9;
  N = normalize(T * nm.x + B * nm.y + Ng * nm.z);
#else
  if (uBump > 0.0) N = bumpNormal(Ng);
#endif

  float NdL = dot(N, L);
  float NgdL = dot(Ng, L);
  float mu0 = max(NdL, 0.0);
  float mu = max(dot(Ng, V), 0.0);
  float diff = mu0;
#ifdef AIRLESS
  // Безатмосферные тела: закон Ломмеля–Зеелигера (нет потемнения к краю, как у Луны)
  float ls = 2.0 * mu0 / (mu0 + mu + 1e-4);
  diff = mix(mu0, ls * 0.5, 0.75);
#endif
  // Мягкий терминатор для гладких (газовых/облачных) тел
  diff = mix(diff, smoothstep(-0.08, 1.0, NgdL), uSmooth * 0.35);
  diff *= smoothstep(-0.02, 0.06, NgdL); // тень на ночной стороне не «просвечивает» из-за рельефа

  vec3 lightCol = vec3(1.0);
#ifdef ATMO
  // Закатное окрашивание у терминатора
  lightCol = mix(uSunsetColor, vec3(1.0), smoothstep(0.0, 0.3, NgdL));
#endif

  float shadow = 1.0;
#ifdef RING_SHADOW
  float den = dot(L, uRingNormalView);
  if (abs(den) > 1e-5) {
    float tt = dot(uCenterView - vViewPos, uRingNormalView) / den;
    if (tt > 0.0) {
      float r = length(vViewPos + L * tt - uCenterView);
      float u = (r - uRingRadii.x) / (uRingRadii.y - uRingRadii.x);
      if (u > 0.0 && u < 1.0) shadow = 1.0 - 0.9 * texture2D(ringMap, vec2(u, 0.5)).a;
    }
  }
#endif

#ifdef EARTH
  float cloud = texture2D(cloudMap, vUv - vec2(uCloudShift, 0.0)).r;
  albedo *= 1.0 - 0.5 * cloud; // тень облаков
#endif

  vec3 col = albedo * lightCol * diff * shadow * uLight + albedo * uAmbient;

#ifdef EARTH
  // Солнечный блик только на воде
  float ocean = texture2D(specMap, vUv).r;
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(Ng, H), 0.0), 160.0) * 0.9 + pow(max(dot(Ng, H), 0.0), 18.0) * 0.05;
  col += vec3(1.0, 0.92, 0.8) * spec * ocean * (1.0 - cloud) * smoothstep(0.0, 0.15, NgdL) * uLight;
  // Огни городов на ночной стороне
  vec3 night = texture2D(nightMap, vUv).rgb;
  float dark = smoothstep(0.08, -0.18, NgdL);
  col += night * night * vec3(1.0, 0.85, 0.6) * 2.2 * dark * (1.0 - 0.8 * cloud);
#endif

#ifdef ATMO
  // Рэлеевская дымка у края диска
  float fres = pow(1.0 - mu, 3.0);
  float lit = smoothstep(-0.25, 0.4, NgdL);
  vec3 haze = mix(uSunsetColor, uAtmoColor, smoothstep(-0.05, 0.35, NgdL));
  col = mix(col, haze * uLight * lit, clamp(fres * uHaze, 0.0, 1.0) * lit);
  col += uAtmoColor * 0.06 * uLight * mu0 * uHaze;
#endif

  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------- Облака Земли ----------
export const cloudFrag = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D map;
uniform vec3 uSunView;
uniform float uLight;
varying vec2 vUv;
varying vec3 vViewPos;
varying vec3 vViewNormal;
varying vec3 vViewTangent;
void main(){
  #include <logdepthbuf_fragment>
  float a = texture2D(map, vUv).r;
  vec3 N = normalize(vViewNormal);
  vec3 L = normalize(uSunView - vViewPos);
  float NdL = dot(N, L);
  float diff = smoothstep(-0.12, 1.0, NdL);
  vec3 tint = mix(vec3(1.0, 0.5, 0.25), vec3(1.0), smoothstep(-0.02, 0.25, NdL));
  gl_FragColor = vec4(vec3(0.95) * tint * diff * uLight + 0.004, a * 0.95);
}
`;

// ---------- Атмосферное свечение (оболочка, BackSide, аддитивно) ----------
export const atmoVert = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vViewPos;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

export const atmoFrag = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uCenterView;
uniform vec3 uSunView;
uniform vec3 uColor;
uniform vec3 uSunsetColor;
uniform float uR;
uniform float uRa;
uniform float uStrength;
uniform float uLight;
varying vec3 vViewPos;
void main(){
  #include <logdepthbuf_fragment>
  vec3 dir = normalize(vViewPos);
  float tca = dot(uCenterView, dir);
  vec3 closest = dir * max(tca, 0.0);
  float h = length(uCenterView - closest);
  float t = clamp((h - uR) / (uRa - uR), 0.0, 1.0);
  float glow = pow(1.0 - t, 2.2) * (1.0 - exp(-40.0 * t) * 0.5);
  vec3 n = normalize(closest - uCenterView);
  vec3 L = normalize(uSunView - uCenterView);
  float m = dot(n, L);
  float lit = smoothstep(-0.35, 0.25, m);
  vec3 col = mix(uSunsetColor, uColor, smoothstep(-0.12, 0.35, m));
  // Рассеяние вперёд — ореол ярче, когда смотрим против Солнца
  float fwd = pow(max(dot(dir, L), 0.0), 8.0);
  gl_FragColor = vec4(col * glow * lit * uStrength * uLight * (1.0 + 2.0 * fwd), 1.0);
}
`;

// ---------- Кольца Сатурна ----------
export const ringVert = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vLocal;
varying vec3 vViewPos;
void main(){
  vLocal = position.xy;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

export const ringFrag = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D map;
uniform vec2 uRadii;      // в радиусах планеты
uniform vec3 uSunView;
uniform vec3 uCenterView;
uniform vec3 uNormalView;
uniform float uPlanetR;   // экваториальный радиус в единицах сцены
uniform float uLight;
varying vec2 vLocal;
varying vec3 vViewPos;
void main(){
  #include <logdepthbuf_fragment>
  float r = length(vLocal);
  float u = (r - uRadii.x) / (uRadii.y - uRadii.x);
  if (u < 0.0 || u > 1.0) discard;
  vec4 tex = texture2D(map, vec2(u, 0.5));
  if (tex.a < 0.004) discard;
  vec3 L = normalize(uSunView - vViewPos);
  vec3 V = normalize(-vViewPos);
  vec3 N = normalize(uNormalView);
  float sl = dot(N, L), sv = dot(N, V);
  // Освещённая сторона — отражение; неосвещённая — свет, прошедший сквозь редкие участки
  float light = (sl * sv > 0.0) ? 0.35 + 0.65 * sqrt(abs(sl)) * 1.4 : (1.0 - tex.a) * 0.9 + 0.03;
  // Тень планеты на кольцах
  vec3 oc = vViewPos - uCenterView;
  float b = dot(oc, L);
  float shadow = 1.0;
  if (b < 0.0) {
    float d = length(oc - L * b);
    shadow = smoothstep(uPlanetR * 0.985, uPlanetR * 1.015, d);
  }
  // Рассеяние вперёд, когда смотрим сквозь кольца на Солнце
  float fwd = pow(max(dot(-V, L), 0.0), 6.0) * (1.0 - tex.a) * 1.5;
  vec3 col = tex.rgb * (light + fwd) * shadow * uLight;
  gl_FragColor = vec4(col, tex.a * 0.96);
}
`;

// ---------- Солнце ----------
export const sunVert = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
varying vec3 vObj;
varying vec3 vViewPos;
varying vec3 vViewNormal;
void main(){
  vUv = uv;
  vObj = normalize(position);
  vViewNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

export const sunFrag = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D map;
uniform float uTime;
uniform float uIntensity;
varying vec2 vUv;
varying vec3 vObj;
varying vec3 vViewPos;
varying vec3 vViewNormal;
${noise}
void main(){
  #include <logdepthbuf_fragment>
  // Медленное «кипение» фотосферы: искажаем UV шумом
  float n1 = snoise(vObj * 4.0 + vec3(0.0, 0.0, uTime * 0.03));
  float n2 = snoise(vObj * 9.0 - vec3(uTime * 0.05, 0.0, 0.0));
  vec2 uv = vUv + vec2(n1, n2) * 0.0025;
  vec3 c = texture2D(map, uv).rgb;
  // Грануляция
  float g = snoise(vObj * 90.0 + uTime * 0.12) * 0.5 + snoise(vObj * 190.0 - uTime * 0.2) * 0.5;
  c *= 0.9 + 0.12 * g;
  // Потемнение к краю диска
  float mu = clamp(dot(normalize(vViewNormal), normalize(-vViewPos)), 0.0, 1.0);
  float limb = 1.0 - 0.56 * (1.0 - mu) - 0.2 * (1.0 - mu) * (1.0 - mu);
  vec3 limbTint = mix(vec3(1.0, 0.6, 0.35), vec3(1.0), pow(mu, 0.5));
  // Контраст текстуры: тёмные участки темнее, яркие — ярче (только они попадают в bloom)
  vec3 tc = pow(c, vec3(1.2));
  // Немного тёплого белого поверх текстуры — Солнце жёлто-оранжевое, а не красное
  vec3 col = (tc * 0.8 + vec3(1.0, 0.78, 0.4) * 0.17) * limb * limbTint * uIntensity;
  // ACES-тонмаппинг обесцвечивает яркие тона — заранее усиливаем насыщенность,
  // иначе оранжевая фотосфера выглядит бежевой
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(l), col, 1.22), 0.0);
  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------- Корона и засветка вокруг Солнца (billboard) ----------
export const coronaVert = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

export const coronaFrag = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uSunFrac;   // радиус Солнца в долях половины плоскости
uniform float uGlare;
varying vec2 vUv;
${noise}
void main(){
  #include <logdepthbuf_fragment>
  vec2 p = vUv * 2.0 - 1.0;
  float d = length(p);
  float r = d / uSunFrac; // в радиусах Солнца
  if (d > 1.0) discard;
  vec2 dir = p / max(d, 1e-5);
  float rays = snoise(vec3(dir * 3.5, uTime * 0.04)) * 0.5 + snoise(vec3(dir * 9.0, uTime * 0.07 + 10.0)) * 0.3;
  float corona = exp(-(r - 1.0) * 3.0) * (0.7 + 0.5 * rays) * 0.6 + 0.2 / (r * r * r);
  corona *= smoothstep(0.95, 1.02, r);
  float glare = exp(-d * 7.0) * 0.35 + exp(-d * 18.0) * 0.8;
  float edge = smoothstep(1.0, 0.6, d);
  vec3 col = vec3(1.0, 0.82, 0.6) * corona * 0.9 + vec3(1.0, 0.9, 0.75) * glare * uGlare;
  gl_FragColor = vec4(col * edge, 1.0);
}
`;
