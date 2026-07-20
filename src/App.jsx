import React, { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";

/* ============================================================
   ERIC — EXPEDITION PORTFOLIO
   A night-alpine 3D mountain as the site's navigation.
   Waypoints (Base Camp → Summit) open the sub-pages.
   Drag = pivot around a fixed axis · Scroll = zoom to pivot.
   ============================================================ */

/* ------------------------- Waypoint map ------------------------- */
const WAYPOINTS = [
  { key: "about",    name: "About Me",  camp: "Base Camp", alt: "5,364 m", pos: [-27, 30],  kind: "tents",  flat: 6.5 },
  { key: "resume",   name: "Resume",    camp: "Camp I",    alt: "6,065 m", pos: [19, 13],   kind: "cabin",  flat: 5.6 },
  { key: "projects", name: "Projects",  camp: "Camp II",   alt: "6,400 m", pos: [-13, 5],   kind: "tents2", flat: 4.8 },
  { key: "contact",  name: "Contact",   camp: "Summit",    alt: "8,849 m", pos: [0.6, 0.4], kind: "flag",   flat: 3.0 },
];
const ORDER = ["about", "resume", "projects", "contact"];

/* ------------------------- Deterministic noise ------------------------- */
function hash2(ix, iz) {
  let n = (ix * 374761393 + iz * 668265263) | 0;
  n = ((n ^ (n >> 13)) * 1274126177) | 0;
  return (((n ^ (n >> 16)) >>> 0) % 100000) / 100000;
}
const smooth = (t) => t * t * (3 - 2 * t);
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  const u = smooth(fx), v = smooth(fz);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
function fbm(x, z) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < 4; o++) {
    sum += amp * vnoise(x * freq, z * freq);
    norm += amp; amp *= 0.5; freq *= 2.15;
  }
  return sum / norm;
}

/* ------------------------- Terrain height field ------------------------- */
function rawHeightAt(x, z) {
  const r = Math.hypot(x, z);
  const ridge = 1 - Math.abs(2 * fbm(x * 0.045 + 7.3, z * 0.045 + 2.1) - 1);
  const rough = fbm(x * 0.16 + 3.7, z * 0.16 + 8.2);
  const core = 36 * Math.exp(-(r * r) / (2 * 23 * 23));
  const foot = 7 * Math.exp(-(r * r) / (2 * 52 * 52));
  const falloff = Math.max(0, 1 - Math.pow(r / 75, 4));
  return core * (0.7 + 0.45 * ridge) + foot * (0.35 + 0.9 * rough) + rough * 2.0 * falloff;
}

/* Level platforms carved into the slope so each camp has ground to sit on */
const PLATEAUS = WAYPOINTS.map((w) => ({ x: w.pos[0], z: w.pos[1], r: w.flat, y: 0 }));
PLATEAUS.forEach((p) => { p.y = rawHeightAt(p.x, p.z); });

function heightAt(x, z) {
  let h = rawHeightAt(x, z);
  for (const p of PLATEAUS) {
    const d = Math.hypot(x - p.x, z - p.z);
    if (d < p.r) {
      const t = smooth(Math.min(1, d / p.r)); // 0 at camp centre → 1 at plateau edge
      h = p.y * (1 - t) + h * t;
    }
  }
  return h;
}

/* ------------------------- 3D scene ------------------------- */
function buildScene(container, hooks) {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const scene = new THREE.Scene();
  const NIGHT = 0x0a1322;
  scene.background = new THREE.Color(NIGHT);
  // fog color matches the sky-dome horizon so distant terrain melts into the sky
  scene.fog = new THREE.Fog(0x1b2c49, 130, 330);

  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 900);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";

  /* Camera rig — one pivot axis + zoom toward the same invisible point */
  const pivot = new THREE.Vector3(0, 15, 0);
  const POLAR = 1.1;                 // fixed — no vertical orbit
  let azimuth = 0.55, azVel = 0;
  let radius = 104, radiusTarget = 104;
  const R_MIN = 42, R_MAX = 155;
  // <-- Change this to adjust how long (ms) the camera waits after the user's
  // last drag/zoom before the slow passive idle rotation resumes.
  const IDLE_RESUME_MS = 3000;
  let lastInteractionAt = -Infinity; // -Infinity so idle drift is ready to go once armed
  const markInteraction = () => { lastInteractionAt = performance.now(); };
  // Gated by the loading screen: stays off until App calls setIdleEnabled(true).
  let idleEnabled = false;
  // User settings (from the gear dropdown): passive rotation and snowfall.
  let rotationEnabled = true;
  let snowEnabled = true;
  // Theme blend: 0 = night, 1 = sunset. themeMix eases toward themeTarget in the loop.
  const THEME_FADE_S = 1.15;
  let themeTarget = 0, themeMix = 0;

  function placeCamera() {
    const sp = Math.sin(POLAR), cp = Math.cos(POLAR);
    camera.position.set(
      pivot.x + radius * Math.sin(azimuth) * sp,
      pivot.y + radius * cp,
      pivot.z + radius * Math.cos(azimuth) * sp
    );
    camera.lookAt(pivot);
  }

  /* Lights — all retinted when the theme blends between night and sunset */
  const hemi = new THREE.HemisphereLight(0x2a3d5c, 0x090d14, 0.85);
  scene.add(hemi);
  const keyLight = new THREE.DirectionalLight(0xbfd4ef, 0.95);   // moon at night, low sun at sunset
  keyLight.position.set(-90, 130, 110);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xf2a0b0, 0.38);  // alpenglow at night, cool haze at sunset
  fillLight.position.set(70, 60, -120);
  scene.add(fillLight);

  /* Terrain */
  const SIZE = 150, SEG = 108;
  let terrainGeo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  terrainGeo.rotateX(-Math.PI / 2);
  {
    const p = terrainGeo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, heightAt(p.getX(i), p.getZ(i)));
  }
  terrainGeo = terrainGeo.toNonIndexed();
  {
    const p = terrainGeo.attributes.position;
    const colors = new Float32Array(p.count * 3);
    const snow = new THREE.Color(0xe9f1f8), snowShade = new THREE.Color(0xc2d5e6);
    const rock = new THREE.Color(0x46586d), rockDark = new THREE.Color(0x33445a);
    const base = new THREE.Color(0x223141), pine = new THREE.Color(0x24382f);
    const tmp = new THREE.Color();
    for (let f = 0; f < p.count; f += 3) {
      const cy = (p.getY(f) + p.getY(f + 1) + p.getY(f + 2)) / 3;
      const cx = (p.getX(f) + p.getX(f + 1) + p.getX(f + 2)) / 3;
      const cz = (p.getZ(f) + p.getZ(f + 1) + p.getZ(f + 2)) / 3;
      const j = hash2(Math.round(cx * 10), Math.round(cz * 10)); // per-facet jitter
      if (cy > 26 + j * 3) tmp.copy(snow).lerp(snowShade, j * 0.55);
      else if (cy > 18) {
        const t = (cy - 18) / 8;
        tmp.copy(j > 0.5 ? rock : rockDark).lerp(snow, Math.min(1, t + (j - 0.5) * 0.5));
      } else if (cy > 5.5) tmp.copy(rock).lerp(rockDark, j);
      else tmp.copy(base).lerp(pine, j * 0.8);
      tmp.offsetHSL(0, 0, (j - 0.5) * 0.03);
      for (let k = 0; k < 3; k++) colors.set([tmp.r, tmp.g, tmp.b], (f + k) * 3);
    }
    terrainGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    terrainGeo.computeVertexNormals();
  }
  scene.add(new THREE.Mesh(
    terrainGeo,
    new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, metalness: 0 })
  ));

  /* Valley floor to the horizon */
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x0d1726, roughness: 1 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.25;
  scene.add(floor);

  /* ---------- Sky: gradient dome, stars, moon/sun, clouds ---------- */
  /* Two palettes; every sky/light parameter lerps between them (see applyTheme). */
  const THEME = {
    night: {
      bg: 0x0a1322, fog: 0x1b2c49, fogNear: 130, fogFar: 330, floor: 0x0d1726,
      hemiSky: 0x2a3d5c, hemiGround: 0x090d14, hemiI: 0.85,
      key: 0xbfd4ef, keyI: 0.95, keyPos: new THREE.Vector3(-90, 130, 110),
      fill: 0xf2a0b0, fillI: 0.38, fillPos: new THREE.Vector3(70, 60, -120),
      horizon: 0x1b2c49, mid: 0x0d1930, zenith: 0x060c18,
      cloud: 0x93a4bf, cloudGlow: 0x000000,
    },
    sunset: {
      bg: 0xffb28a, fog: 0xffbe8c, fogNear: 85, fogFar: 250, floor: 0x7a5648,
      hemiSky: 0xffb99a, hemiGround: 0x8a6258, hemiI: 0.9,
      key: 0xff9d68, keyI: 0.85, keyPos: new THREE.Vector3(140, 38, -160),
      fill: 0xc98bb8, fillI: 0.34, fillPos: new THREE.Vector3(-70, 55, 120),
      horizon: 0xffbe8c, mid: 0xf9909e, zenith: 0xa583b4,
      cloud: 0xffd9c4, cloudGlow: 0x572415,
    },
  };

  /* Gradient sky dome (horizon → mid → zenith); vertex colors lerped on theme change */
  const domeGeo = new THREE.SphereGeometry(470, 40, 24);
  const domeNight = new Float32Array(domeGeo.attributes.position.count * 3);
  const domeDay = new Float32Array(domeNight.length);
  {
    const pos = domeGeo.attributes.position;
    const cH = new THREE.Color(), cM = new THREE.Color(), cZ = new THREE.Color(), out = new THREE.Color();
    const fillCols = (arr, th) => {
      cH.setHex(th.horizon); cM.setHex(th.mid); cZ.setHex(th.zenith);
      for (let i = 0; i < pos.count; i++) {
        const h = Math.max(0, pos.getY(i) / 470);
        if (h < 0.32) out.copy(cH).lerp(cM, smooth(h / 0.32));
        else out.copy(cM).lerp(cZ, smooth((h - 0.32) / 0.68));
        arr.set([out.r, out.g, out.b], i * 3);
      }
    };
    fillCols(domeNight, THEME.night);
    fillCols(domeDay, THEME.sunset);
    domeGeo.setAttribute("color", new THREE.BufferAttribute(domeNight.slice(), 3));
    const domeMesh = new THREE.Mesh(domeGeo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
    }));
    domeMesh.renderOrder = -2;
    scene.add(domeMesh);
  }

  /* Star field: base layer + a few brighter stars + a faint milky-way band */
  function makeStars(count, seedA, seedB, size, color, opacity) {
    const arr = [];
    for (let i = 0; i < count; i++) {
      const a = hash2(i, seedA) * Math.PI * 2, e = 0.1 + hash2(i, seedB) * 1.3, R = 430;
      arr.push(R * Math.cos(e) * Math.cos(a), 26 + R * Math.sin(e), R * Math.cos(e) * Math.sin(a));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
    const m = new THREE.PointsMaterial({
      color, size, sizeAttenuation: false, fog: false, transparent: true, opacity, depthWrite: false,
    });
    scene.add(new THREE.Points(g, m));
    return { m, base: opacity };
  }
  const starsFar = makeStars(380, 7, 13, 1.7, 0xdfe9f5, 0.9);
  const starsBright = makeStars(90, 57, 71, 2.6, 0xfff3d9, 0.95);
  const starsBand = (() => {
    const nrm = new THREE.Vector3(0.42, 0.62, 0.66).normalize();
    const u = new THREE.Vector3(1, 0, 0).cross(nrm).normalize();
    const v = new THREE.Vector3().crossVectors(nrm, u);
    const arr = [], p = new THREE.Vector3();
    for (let i = 0; i < 260; i++) {
      const a = hash2(i, 313) * Math.PI * 2;
      const off = (hash2(i, 419) + hash2(i, 523) - 1) * 0.24;
      p.copy(u).multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a))
        .addScaledVector(nrm, off).normalize().multiplyScalar(432);
      if (p.y < 12) continue;
      arr.push(p.x, p.y + 18, p.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
    const m = new THREE.PointsMaterial({
      color: 0xcfdcee, size: 1.1, sizeAttenuation: false, fog: false,
      transparent: true, opacity: 0.5, depthWrite: false,
    });
    scene.add(new THREE.Points(g, m));
    return { m, base: 0.5 };
  })();

  /* Moon (night) and low sun (sunset) crossfade */
  const moonMat = new THREE.MeshBasicMaterial({ color: 0xe8f0fa, fog: false, transparent: true });
  const moon = new THREE.Mesh(new THREE.SphereGeometry(9, 20, 20), moonMat);
  moon.position.set(-190, 150, 230);
  const moonHaloMat = new THREE.MeshBasicMaterial({
    color: 0xbfd2ea, fog: false, transparent: true, opacity: 0.14, depthWrite: false,
  });
  const moonHalo = new THREE.Mesh(new THREE.SphereGeometry(13.5, 20, 20), moonHaloMat);
  moonHalo.position.copy(moon.position);
  moonHalo.renderOrder = 1;
  const sunMat = new THREE.MeshBasicMaterial({ color: 0xffdfa3, fog: false, transparent: true, opacity: 0 });
  const sun = new THREE.Mesh(new THREE.SphereGeometry(15, 24, 24), sunMat);
  sun.position.set(272, 74, -312); // matches the sunset key-light direction
  const sunGlowMat = new THREE.MeshBasicMaterial({
    color: 0xffb26e, fog: false, transparent: true, opacity: 0, depthWrite: false,
  });
  const sunGlow = new THREE.Mesh(new THREE.SphereGeometry(34, 24, 24), sunGlowMat);
  sunGlow.position.copy(sun.position);
  sunGlow.renderOrder = 1;
  // wide, very faint outer flare around the sun — kept subtle
  const sunFlareMat = new THREE.MeshBasicMaterial({
    color: 0xffcfa8, fog: false, transparent: true, opacity: 0, depthWrite: false,
  });
  const sunFlare = new THREE.Mesh(new THREE.SphereGeometry(80, 24, 24), sunFlareMat);
  sunFlare.position.copy(sun.position);
  sunFlare.renderOrder = 1;
  scene.add(moon, moonHalo, sun, sunGlow, sunFlare);

  /* A few low-poly clouds drifting far out; they pick up the theme lighting */
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0x93a4bf, flatShading: true, roughness: 1, transparent: true, opacity: 0.92,
  });
  const clouds = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const cl = new THREE.Group();
    const puffs = 3 + Math.floor(hash2(i, 611) * 3);
    for (let k = 0; k < puffs; k++) {
      const s = new THREE.Mesh(new THREE.IcosahedronGeometry(4 + hash2(i * 7 + k, 727) * 3.5, 0), cloudMat);
      s.position.set(
        k * 5.2 - puffs * 2.6 + (hash2(i + k, 811) - 0.5) * 3,
        (hash2(i + k, 907) - 0.5) * 2.2,
        (hash2(i + k, 1013) - 0.5) * 4
      );
      s.scale.y = 0.4 + hash2(i + k, 1117) * 0.14;
      cl.add(s);
    }
    const a = (i / 6) * Math.PI * 2 + hash2(i, 1201) * 0.8;
    const r = 200 + hash2(i, 1301) * 70; // outside the camera's orbit so none loom into view
    cl.position.set(Math.cos(a) * r, 70 + hash2(i, 1409) * 24, Math.sin(a) * r);
    clouds.add(cl);
  }
  scene.add(clouds);

  /* Blend every sky/light parameter between the two themes */
  const _ca = new THREE.Color(), _cb = new THREE.Color();
  const mixHex = (target, hexA, hexB, k) => target.copy(_ca.setHex(hexA)).lerp(_cb.setHex(hexB), k);
  function applyTheme(raw) {
    const k = smooth(THREE.MathUtils.clamp(raw, 0, 1));
    const N = THEME.night, D = THEME.sunset;
    mixHex(scene.background, N.bg, D.bg, k);
    mixHex(scene.fog.color, N.fog, D.fog, k);
    scene.fog.near = THREE.MathUtils.lerp(N.fogNear, D.fogNear, k);
    scene.fog.far = THREE.MathUtils.lerp(N.fogFar, D.fogFar, k);
    mixHex(floorMat.color, N.floor, D.floor, k);
    mixHex(hemi.color, N.hemiSky, D.hemiSky, k);
    mixHex(hemi.groundColor, N.hemiGround, D.hemiGround, k);
    hemi.intensity = THREE.MathUtils.lerp(N.hemiI, D.hemiI, k);
    mixHex(keyLight.color, N.key, D.key, k);
    keyLight.intensity = THREE.MathUtils.lerp(N.keyI, D.keyI, k);
    keyLight.position.lerpVectors(N.keyPos, D.keyPos, k);
    mixHex(fillLight.color, N.fill, D.fill, k);
    fillLight.intensity = THREE.MathUtils.lerp(N.fillI, D.fillI, k);
    fillLight.position.lerpVectors(N.fillPos, D.fillPos, k);
    const night = 1 - k;
    starsFar.m.opacity = starsFar.base * night;
    starsBright.m.opacity = starsBright.base * night;
    starsBand.m.opacity = starsBand.base * night;
    moonMat.opacity = night;
    moonHaloMat.opacity = 0.14 * night;
    sunMat.opacity = k;
    sunGlowMat.opacity = 0.28 * k;
    sunFlareMat.opacity = 0.1 * k;
    mixHex(cloudMat.color, N.cloud, D.cloud, k);
    mixHex(cloudMat.emissive, N.cloudGlow, D.cloudGlow, k);
    outlineMats.forEach((om) => mixHex(om.color, 0xffb454, 0x2f6fbf, k));
    const dc = domeGeo.attributes.color;
    for (let i = 0; i < dc.array.length; i++) dc.array[i] = domeNight[i] + (domeDay[i] - domeNight[i]) * k;
    dc.needsUpdate = true;
  }

  /* Falling snow */
  let snowPts = null, snowArr = null;
  if (!reduceMotion) {
    const N = 500;
    snowArr = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      snowArr[i * 3] = (hash2(i, 31) - 0.5) * 170;
      snowArr[i * 3 + 1] = hash2(i, 37) * 70;
      snowArr[i * 3 + 2] = (hash2(i, 41) - 0.5) * 170;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(snowArr, 3));
    snowPts = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xffffff, size: 0.5, transparent: true, opacity: 0.75, depthWrite: false
    }));
    scene.add(snowPts);
  }

  /* Trees on the lower slopes */
  {
    const treeGeo = new THREE.ConeGeometry(1.1, 3.2, 5);
    const treeMat = new THREE.MeshStandardMaterial({ color: 0x1f3a2e, flatShading: true, roughness: 1 });
    let placed = 0, i = 0;
    while (placed < 64 && i < 900) {
      i++;
      const x = (hash2(i, 101) - 0.5) * 132, z = (hash2(i, 211) - 0.5) * 132;
      const r = Math.hypot(x, z), h = heightAt(x, z);
      if (r < 34 || r > 64 || h > 13 || h < 1.2) continue;
      const t = new THREE.Mesh(treeGeo, treeMat);
      const s = 0.65 + hash2(i, 307) * 0.7;
      t.scale.setScalar(s);
      t.position.set(x, h + 1.6 * s - 0.15, z);
      t.rotation.y = hash2(i, 401) * Math.PI;
      scene.add(t);
      placed++;
    }
  }

  /* ---------- Waypoint structures (clickable hotspots) ---------- */
  const LANTERN = 0xffb454;
  const pickMeshes = [];
  const outlineMats = []; // hover-outline materials, retinted gold → blue by applyTheme
  const hotspots = {}; // key -> { group, outline, anchor }
  const anims = [];    // per-frame animation callbacks (smoke, fire flicker...)

  /* Deep-traversal hotspot finisher: registers every mesh for picking and
     builds a matching amber outline shell (handles nested groups). */
  function finishHotspot(key, group, anchorHeight) {
    scene.add(group);
    group.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
    const meshes = [];
    group.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const outline = new THREE.Group();
    const rel = new THREE.Matrix4();
    meshes.forEach((o) => {
      if (!o.userData.noPick) { o.userData.hotspotKey = key; pickMeshes.push(o); }
      if (o.userData.noOutline) return;
      const oMat = new THREE.MeshBasicMaterial({ color: LANTERN, side: THREE.BackSide });
      outlineMats.push(oMat);
      const m = new THREE.Mesh(o.geometry, oMat);
      rel.multiplyMatrices(inv, o.matrixWorld);
      rel.decompose(m.position, m.quaternion, m.scale);
      m.scale.multiplyScalar(1.13);
      outline.add(m);
    });
    outline.visible = false;
    group.add(outline);
    hotspots[key] = { group, outline, anchor: group.position.clone().add(new THREE.Vector3(0, anchorHeight, 0)) };
  }

  const smoothMat = (color, rough = 0.85, metal = 0) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
  const warmLight = (i = 1.1, d = 9) => new THREE.PointLight(LANTERN, i, d);

  /* Smooth dome tent with crossed poles and an entrance */
  function makeDomeTent(color, s = 1) {
    const tent = new THREE.Group();
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(1.05 * s, 28, 18, 0, Math.PI * 2, 0, Math.PI / 2),
      smoothMat(color, 0.7)
    );
    dome.scale.y = 0.82;
    const entrance = new THREE.Mesh(
      new THREE.CircleGeometry(0.42 * s, 20, 0, Math.PI),
      smoothMat(0x1c2733, 1)
    );
    entrance.position.set(0, 0.02, 1.045 * s);
    entrance.rotation.x = -0.24;
    entrance.userData.noOutline = true;
    const poleMat = smoothMat(0x9aa6b8, 0.45, 0.5);
    [0.8, -0.8].forEach((ry) => {
      const arch = new THREE.Mesh(new THREE.TorusGeometry(1.05 * s, 0.022 * s, 8, 36, Math.PI), poleMat);
      arch.scale.y = 0.84;
      arch.rotation.y = ry;
      arch.userData.noOutline = true;
      tent.add(arch);
    });
    tent.add(dome, entrance);
    return tent;
  }

  /* Small campfire with flickering light */
  function makeCampfire() {
    const fire = new THREE.Group();
    const stoneMat = smoothMat(0x5a6878, 1);
    for (let i = 0; i < 6; i++) {
      const st = new THREE.Mesh(new THREE.DodecahedronGeometry(0.11, 1), stoneMat);
      const a = (i / 6) * Math.PI * 2;
      st.position.set(Math.cos(a) * 0.34, 0.06, Math.sin(a) * 0.34);
      st.userData.noOutline = true;
      fire.add(st);
    }
    const ember = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xff8c3a }));
    ember.position.y = 0.09;
    ember.userData.noOutline = true;
    const glow = new THREE.PointLight(0xff9040, 1.15, 6.5);
    glow.position.y = 0.35;
    fire.add(ember, glow);
    anims.push((t) => {
      glow.intensity = 1.0 + Math.sin(t * 9) * 0.25 + Math.sin(t * 23 + 1.7) * 0.12;
      ember.scale.setScalar(1 + 0.1 * Math.sin(t * 11));
    });
    return fire;
  }

  WAYPOINTS.forEach((wp) => {
    const [x, z] = wp.pos;
    const y = heightAt(x, z);
    const g = new THREE.Group();
    g.position.set(x, y - 0.06, z);
    g.rotation.y = wp.kind === "flag" ? 0 : Math.atan2(x, z); // face outward / downhill

    if (wp.kind === "tents") {                       // Base Camp — dome tents + fire + gear
      const t1 = makeDomeTent(0xe8833a, 1.15); t1.position.set(-0.3, 0, -0.5);
      const t2 = makeDomeTent(0xd9c14a, 0.82); t2.position.set(2.2, 0, 0.9); t2.rotation.y = -0.6;
      const t3 = makeDomeTent(0xc9502e, 0.92); t3.position.set(-2.4, 0, 0.9); t3.rotation.y = 0.55;
      const fire = makeCampfire(); fire.position.set(0.2, 0, 2.3);
      const duffelMat = smoothMat(0x37588f, 0.8);
      const d1 = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.62, 14), duffelMat);
      d1.rotation.z = Math.PI / 2; d1.rotation.y = 0.4; d1.position.set(1.15, 0.17, -1.1);
      const d2 = d1.clone(); d2.position.set(1.5, 0.17, -0.75); d2.rotation.y = 1.2;
      const l = warmLight(0.9, 9); l.position.set(0, 1.5, 0.2);
      g.add(t1, t2, t3, fire, d1, d2, l);
      finishHotspot(wp.key, g, 2.7);
    } else if (wp.kind === "cabin") {                // Camp I — detailed log cabin
      const wood = smoothMat(0x6b4f3a, 0.95);
      const darkWood = smoothMat(0x463225, 1);
      const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.5, 1.9), wood);
      body.position.y = 0.75;
      // log courses along the front and back walls
      const logGeo = new THREE.CylinderGeometry(0.075, 0.075, 2.66, 12);
      logGeo.rotateZ(Math.PI / 2);
      for (let i = 0; i < 5; i++) {
        const lf = new THREE.Mesh(logGeo, wood);
        lf.position.set(0, 0.18 + i * 0.3, 0.96);
        lf.userData.noOutline = true;
        const lb = lf.clone(); lb.position.z = -0.96;
        g.add(lf, lb);
      }
      // roof: dark prism + snow layer on top
      const roofGeo = new THREE.CylinderGeometry(1.6, 1.6, 3.0, 3);
      roofGeo.rotateZ(Math.PI / 2);   // prism axis along X (cabin length)
      roofGeo.rotateX(-Math.PI / 2);  // ridge vertex points up
      const roof = new THREE.Mesh(roofGeo, darkWood);
      roof.scale.y = 0.72;
      roof.position.y = 2.08;
      const snowCap = new THREE.Mesh(roofGeo, smoothMat(0xe9f1f8, 0.95));
      snowCap.scale.set(0.92, 0.8, 0.84);
      snowCap.position.y = 2.16;
      snowCap.userData.noOutline = true;
      // door + two framed windows
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.95, 0.05), darkWood);
      door.position.set(-0.7, 0.5, 0.965);
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), smoothMat(0xc9a227, 0.4, 0.7));
      knob.position.set(-0.5, 0.5, 1.0); knob.userData.noOutline = true;
      const winMake = (wx) => {
        const frame = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.52, 0.05), darkWood);
        frame.position.set(wx, 0.85, 0.965);
        const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.4),
          new THREE.MeshBasicMaterial({ color: LANTERN }));
        glass.position.set(wx, 0.85, 1.0);
        glass.userData.noOutline = true;
        return [frame, glass];
      };
      // porch with railing
      const porch = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.14, 1.0), darkWood);
      porch.position.set(0, 0.07, 1.45);
      const railMat = smoothMat(0x584231, 1);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.05, 0.05), railMat);
      rail.position.set(0, 0.52, 1.9); rail.userData.noOutline = true;
      const posts = [-1.35, -0.45, 0.45, 1.35].map((px) => {
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.42, 10), railMat);
        p.position.set(px, 0.31, 1.9); p.userData.noOutline = true;
        return p;
      });
      // chimney + drifting smoke
      const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.9, 0.32), smoothMat(0x51586b, 1));
      chimney.position.set(0.8, 2.95, -0.3);
      const smokes = [0, 0.34, 0.67].map((phase) => {
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10),
          new THREE.MeshBasicMaterial({ color: 0xbfc9d6, transparent: true, opacity: 0.4, depthWrite: false }));
        s.userData.noOutline = true; s.userData.noPick = true;
        s.position.set(0.8, 3.42 + phase * 0.5, -0.3);
        anims.push((t) => {
          const f = (t * 0.22 + phase) % 1;
          s.position.set(0.8 + f * 0.35, 3.42 + f * 1.9, -0.3 + f * 0.2);
          s.material.opacity = 0.42 * (1 - f);
          s.scale.setScalar(0.55 + f * 1.6);
        });
        return s;
      });
      // firewood stack beside the wall
      const logPile = smoothMat(0x7a5a3e, 1);
      const wood1 = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.6, 12), logPile);
      wood1.rotation.x = Math.PI / 2; wood1.position.set(1.55, 0.09, 0.15); wood1.userData.noOutline = true;
      const wood2 = wood1.clone(); wood2.position.set(1.55, 0.09, 0.38);
      const wood3 = wood1.clone(); wood3.position.set(1.55, 0.26, 0.27);
      // lantern by the door
      const lampPost = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.8, 10), railMat);
      lampPost.position.set(-1.25, 0.5, 1.5); lampPost.userData.noOutline = true;
      const lampGlow = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10),
        new THREE.MeshBasicMaterial({ color: LANTERN }));
      lampGlow.position.set(-1.25, 0.95, 1.5); lampGlow.userData.noOutline = true;
      const lampLight = new THREE.PointLight(LANTERN, 0.55, 4.5);
      lampLight.position.set(-1.25, 1.0, 1.55);
      const l = warmLight(1.15, 10); l.position.set(0, 1.2, 1.7);
      g.add(body, roof, snowCap, door, knob, ...winMake(0.35), ...winMake(1.05),
        porch, rail, ...posts, chimney, ...smokes, wood1, wood2, wood3,
        lampPost, lampGlow, lampLight, l);
      finishHotspot(wp.key, g, 3.6);
    } else if (wp.kind === "tents2") {               // Camp II — high camp, gear + O2 bottles
      const t1 = makeDomeTent(0xe0b23c, 0.95); t1.position.set(-0.1, 0, 0.1);
      const t2 = makeDomeTent(0xe8833a, 0.72); t2.position.set(1.7, 0, -0.5); t2.rotation.y = -0.7;
      const crateMat = smoothMat(0x7a6248, 1);
      const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), crateMat);
      c1.position.set(-1.5, 0.3, 0.6); c1.rotation.y = 0.5;
      const c2 = c1.clone(); c2.position.set(-1.25, 0.3, -0.5); c2.rotation.y = 1.1;
      const c3 = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.45, 0.45), crateMat);
      c3.position.set(-1.42, 0.83, 0.55); c3.rotation.y = 0.9; c3.userData.noOutline = true;
      const o2Mat = smoothMat(0x3b82c4, 0.45, 0.55);
      const bottles = [0, 1, 2].map((i) => {
        const b = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.44, 14), o2Mat);
        b.position.set(0.9 + i * 0.2, 0.22, 0.95);
        b.rotation.z = 0.12 * (i - 1);
        b.userData.noOutline = true;
        return b;
      });
      const l = warmLight(0.9, 8); l.position.set(0.3, 1.2, 0.3);
      g.add(t1, t2, c1, c2, c3, ...bottles, l);
      finishHotspot(wp.key, g, 2.5);
    } else {                                          // Summit — flag, cairn, prayer flags
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.07, 3.6, 14),
        smoothMat(0x9aa7b8, 0.4, 0.5)
      );
      pole.position.y = 1.8;
      const flagGeo = new THREE.PlaneGeometry(1.7, 1.0, 14, 6);
      flagGeo.translate(0.85, 0, 0);
      const flag = new THREE.Mesh(flagGeo,
        new THREE.MeshStandardMaterial({ color: 0xe04141, side: THREE.DoubleSide }));
      flag.position.set(0.07, 3.0, 0);
      flag.userData.flag = flagGeo.attributes.position.array.slice(); // rest pose
      const cairn = new THREE.Mesh(new THREE.DodecahedronGeometry(0.55, 1),
        smoothMat(0x5c6b7d, 1));
      cairn.position.y = 0.3;
      // string of prayer flags down to the snow
      const P0 = new THREE.Vector3(0.05, 3.3, 0), P1 = new THREE.Vector3(2.35, 0.75, 1.15);
      const flagCols = [0x3b6fd4, 0xffffff, 0xd94040, 0x3ba55d, 0xe8c33c];
      for (let i = 0; i < 7; i++) {
        const u = (i + 0.5) / 7;
        const q = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.16),
          new THREE.MeshStandardMaterial({ color: flagCols[i % 5], side: THREE.DoubleSide, roughness: 0.9 }));
        q.position.lerpVectors(P0, P1, u);
        q.position.y -= Math.sin(u * Math.PI) * 0.32;
        q.rotation.y = -Math.atan2(P1.z - P0.z, P1.x - P0.x);
        q.userData.noOutline = true;
        g.add(q);
      }
      const l = warmLight(0.7, 7); l.position.set(0, 2.6, 0.8);
      g.add(pole, flag, cairn, l);
      finishHotspot(wp.key, g, 4.4);
      hotspots.contact.flagMesh = flag;
    }
  });

  /* ---------- The climber (small, but fully kitted out) ---------- */
  const climber = new THREE.Group();
  {
    const red = smoothMat(0xe04141, 0.7);
    const dark = smoothMat(0x232d3b, 0.9);
    const skin = smoothMat(0xf3e6d8, 0.8);
    // legs + boots
    [-0.075, 0.075].forEach((lx) => {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.058, 0.34, 12), dark);
      leg.position.set(lx, 0.17, 0);
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.07, 0.15), smoothMat(0x11161f, 1));
      boot.position.set(lx, 0.035, 0.03);
      climber.add(leg, boot);
    });
    // torso (jacket)
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.165, 0.42, 14), red);
    torso.position.y = 0.55;
    // arms: left trekking, right raised with ice axe
    const armL = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.32, 10), red);
    armL.position.set(-0.19, 0.55, 0.03); armL.rotation.z = 0.35; armL.rotation.x = -0.2;
    const armR = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.32, 10), red);
    armR.position.set(0.21, 0.68, 0.04); armR.rotation.z = -1.15;
    const gloveL = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), dark);
    gloveL.position.set(-0.25, 0.41, 0.09);
    const gloveR = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), dark);
    gloveR.position.set(0.35, 0.77, 0.05);
    // ice axe in the raised hand
    const axe = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.55, 10), smoothMat(0x8a94a6, 0.4, 0.6));
    const axeHead = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.035, 0.035), smoothMat(0xc2ccd8, 0.35, 0.7));
    axeHead.position.y = 0.27;
    axe.add(shaft, axeHead);
    axe.position.set(0.37, 0.86, 0.06);
    axe.rotation.z = -0.45; axe.rotation.x = 0.12;
    // head, helmet, headlamp
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), skin);
    head.position.y = 0.92;
    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.115, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.58),
      smoothMat(0xe8833a, 0.5)
    );
    helmet.position.y = 0.935;
    const lamp = new THREE.PointLight(0xfff2cf, 0.7, 4.5);
    lamp.position.set(0, 0.95, 0.35);
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xfff2cf }));
    glow.position.set(0, 0.95, 0.1);
    // backpack + sleeping roll
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.32, 0.13), smoothMat(0x2e4a70, 0.8));
    pack.position.set(0, 0.6, -0.17);
    const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.26, 12), smoothMat(0xe0b23c, 0.85));
    roll.rotation.z = Math.PI / 2;
    roll.position.set(0, 0.8, -0.18);
    climber.add(torso, armL, armR, gloveL, gloveR, axe, head, helmet, lamp, glow, pack, roll);
    climber.userData.lamp = lamp;
    const cx = 6.5, cz = 9.5;
    climber.position.set(cx, heightAt(cx, cz) - 0.03, cz);
    climber.rotation.y = Math.PI + 0.5;
    scene.add(climber);
  }

  /* ---------- Interaction: pivot drag, zoom, hover, click ---------- */
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hoverKey = null;
  let dragging = false, lastX = 0, lastY = 0, movedPx = 0;

  function setHighlight(key) {
    if (hoverKey === key) return;
    if (hoverKey && hotspots[hoverKey]) hotspots[hoverKey].outline.visible = false;
    hoverKey = key;
    if (key && hotspots[key]) hotspots[key].outline.visible = true;
    renderer.domElement.style.cursor = key ? "pointer" : "grab";
    hooks.onHover(key);
  }

  function raycastAt(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(pickMeshes, false)[0];
    return hit ? hit.object.userData.hotspotKey : null;
  }

  const el = renderer.domElement;
  const onPointerDown = (e) => {
    dragging = true; markInteraction(); movedPx = 0; lastX = e.clientX; lastY = e.clientY;
    el.style.cursor = "grabbing";
    el.setPointerCapture && el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (dragging) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      movedPx += Math.abs(dx) + Math.abs(dy);
      azimuth -= dx * 0.0052;           // one axis only — pivot around the reference point
      azVel = -dx * 0.0052;
      markInteraction();
    } else {
      setHighlight(raycastAt(e.clientX, e.clientY));
    }
  };
  const onPointerUp = (e) => {
    if (dragging && movedPx < 6) {
      const key = raycastAt(e.clientX, e.clientY);
      if (key) hooks.onSelect(key);
    }
    dragging = false;
    el.style.cursor = hoverKey ? "pointer" : "grab";
  };
  const onPointerLeave = () => { if (!dragging) setHighlight(null); };
  const onWheel = (e) => {
    e.preventDefault();
    markInteraction();
    radiusTarget = THREE.MathUtils.clamp(radiusTarget * (1 + e.deltaY * 0.0011), R_MIN, R_MAX);
  };
  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointerleave", onPointerLeave);
  el.addEventListener("wheel", onWheel, { passive: false });
  el.style.cursor = "grab";
  el.style.touchAction = "none";

  /* ---------- Resize ---------- */
  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();

  /* ---------- Render loop ---------- */
  const anchorV = new THREE.Vector3();
  let raf = 0;
  const clock = new THREE.Clock();
  let lastT = 0;
  function loop() {
    raf = requestAnimationFrame(loop);
    if (hooks.isPaused()) return;
    const t = clock.getElapsedTime();
    const dt = Math.min(t - lastT, 0.1); lastT = t;

    // ease the sky and lighting between night and sunset
    if (themeMix !== themeTarget) {
      const step = reduceMotion ? 1 : dt / THEME_FADE_S;
      themeMix += THREE.MathUtils.clamp(themeTarget - themeMix, -step, step);
      applyTheme(themeMix);
    }

    if (!dragging) {
      azimuth += azVel; azVel *= 0.92;                       // inertia
      const idleFor = performance.now() - lastInteractionAt;
      if (!reduceMotion && idleEnabled && rotationEnabled && idleFor > IDLE_RESUME_MS) azimuth += 0.0011; // idle drift
    }
    radius += (radiusTarget - radius) * 0.1;
    placeCamera();

    // waving summit flag
    const flag = hotspots.contact.flagMesh;
    if (flag) {
      const p = flag.geometry.attributes.position, rest = flag.userData.flag;
      for (let i = 0; i < p.count; i++) {
        const x = rest[i * 3];
        p.setZ(i, Math.sin(x * 2.6 - t * 5) * 0.14 * (x / 1.7));
      }
      p.needsUpdate = true;
      flag.geometry.computeVertexNormals();
    }
    // climber stays fixed in place; headlamp still pulses gently
    if (!reduceMotion) {
      climber.userData.lamp.intensity = 0.6 + 0.18 * Math.sin(t * 2.4);
      anims.forEach((f) => f(t)); // chimney smoke, campfire flicker...
      clouds.rotation.y = t * 0.0045;              // slow cloud drift
      const nightF = 1 - smooth(themeMix);         // stars twinkle, fade out at sunset
      starsFar.m.opacity = starsFar.base * (0.86 + 0.14 * Math.sin(t * 0.8)) * nightF;
      starsBright.m.opacity = starsBright.base * (0.84 + 0.16 * Math.sin(t * 1.27 + 2.1)) * nightF;
    }
    // snowfall
    if (snowPts && snowEnabled) {
      for (let i = 0; i < snowArr.length; i += 3) {
        snowArr[i + 1] -= 0.055 + (i % 7) * 0.004;
        snowArr[i] += Math.sin(t + i) * 0.006;
        if (snowArr[i + 1] < 0) snowArr[i + 1] = 68;
      }
      snowPts.geometry.attributes.position.needsUpdate = true;
    }
    // hover tooltip anchor -> screen coords
    if (hoverKey && hotspots[hoverKey]) {
      anchorV.copy(hotspots[hoverKey].anchor).project(camera);
      const rect = renderer.domElement.getBoundingClientRect();
      hooks.onAnchor((anchorV.x * 0.5 + 0.5) * rect.width, (-anchorV.y * 0.5 + 0.5) * rect.height);
    }
    renderer.render(scene, camera);
  }
  loop();

  return {
    setHighlight,
    setIdleEnabled(v) { idleEnabled = v; },
    setRotationEnabled(v) { rotationEnabled = v; },
    setSnowEnabled(v) { snowEnabled = v; if (snowPts) snowPts.visible = v; },
    setDayMode(v) { themeTarget = v ? 1 : 0; },
    zoomBy(f) { markInteraction(); radiusTarget = THREE.MathUtils.clamp(radiusTarget * f, R_MIN, R_MAX); },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerleave", onPointerLeave);
      el.removeEventListener("wheel", onWheel);
      renderer.dispose();
      container.contains(el) && container.removeChild(el);
    },
  };
}

/* ============================================================
   Sub-page building blocks (sleek wireframe pages)
   ============================================================ */
const Placeholder = ({ label, ratio = "4 / 3", style }) => (
  <div className="ep-ph" style={{ aspectRatio: ratio, ...style }}>
    <span>{label}</span>
  </div>
);

/* Placeholder button for links Eric will wire up later (avoids alert(), which
   can be blocked in sandboxed frames) — shows an inline hint when clicked. */
const StubButton = ({ children, hint, variant = "ep-btn-primary" }) => {
  const [note, setNote] = useState(false);
  return (
    <span className="ep-stub">
      <button className={`ep-btn ${variant}`} onClick={() => setNote(true)}>{children}</button>
      {note && <em className="ep-mono ep-stub-note">{hint}</em>}
    </span>
  );
};

/* Toggle row inside the settings dropdown */
const SettingRow = ({ label, on, onToggle, disabled }) => (
  <button
    className={`ep-set-row ${on ? "is-on" : ""}`}
    role="switch"
    aria-checked={on}
    disabled={disabled}
    onClick={onToggle}
  >
    <span className="ep-set-label">{label}</span>
    <span className="ep-set-switch" aria-hidden="true"><span className="ep-set-knob" /></span>
  </button>
);

const Contours = () => (
  <svg className="ep-contours" viewBox="0 0 300 300" aria-hidden="true">
    {[0, 1, 2, 3, 4].map((i) => (
      <path
        key={i}
        d={`M ${20 + i * 24} 290 C ${40 + i * 20} ${180 - i * 22}, ${150 + i * 8} ${120 - i * 16}, ${290} ${60 + i * 30}`}
        fill="none"
      />
    ))}
  </svg>
);

function PageShell({ wp, onNav, children }) {
  const idx = ORDER.indexOf(wp.key);
  const next = idx < ORDER.length - 1 ? WAYPOINTS.find((w) => w.key === ORDER[idx + 1]) : null;
  return (
    <div className="ep-page" key={wp.key}>
      <Contours />
      <header className="ep-page-top">
        <button className="ep-btn ep-btn-ghost" onClick={() => onNav(null)}>← Back to the mountain</button>
        <span className="ep-mono ep-way">{wp.camp} · ALT {wp.alt}</span>
      </header>
      <main className="ep-page-body">{children}</main>
      <footer className="ep-page-foot">
        <button className="ep-btn ep-btn-ghost" onClick={() => onNav(null)}>⌂ Home</button>
        {next && (
          <button className="ep-btn ep-btn-ghost" onClick={() => onNav(next.key)}>
            Next waypoint: {next.camp} — {next.name} →
          </button>
        )}
      </footer>
    </div>
  );
}

/* ------------------------- Pages ------------------------- */
function AboutPage({ onNav }) {
  return (
    <PageShell wp={WAYPOINTS[0]} onNav={onNav}>
      <p className="ep-eyebrow ep-mono">BASE CAMP — WHERE THE ROUTE BEGINS</p>
      <h1>About Me</h1>
      <div className="ep-grid-2">
        <Placeholder label="PORTRAIT · 4:5" ratio="4 / 5" />
        <div>
          <p className="ep-lede">
            I'm Eric — a Rotman Commerce student at the University of Toronto studying finance and
            economics with a data science focus, aiming for markets-facing roles in sales &amp; trading
            and public-markets investing.
          </p>
          <p className="ep-body">
            [Replace with 2–3 short paragraphs: what you're building toward, what you're involved in
            on campus — RCSF, Rotman Everest Investments, RITC — and what you do off the clock.]
          </p>
          <div className="ep-chips">
            <span>Toronto, ON</span><span>BCom '28</span><span>S&amp;T · Public markets</span>
            <span>Lifting</span><span>Snowboarding</span>
          </div>
          <div className="ep-btn-row">
            <button className="ep-btn ep-btn-primary" onClick={() => onNav("resume")}>View resume</button>
            <button className="ep-btn ep-btn-outline" onClick={() => onNav("contact")}>Get in touch</button>
          </div>
        </div>
      </div>
    </PageShell>
  );
}

function ResumePage({ onNav }) {
  const rows = [
    ["Rotman Commerce Student Fund", "Senior Analyst", "[Dates]", "[1–2 lines on credit / equity analysis work]"],
    ["Rotman Everest Investments", "Equity Research", "[Dates]", "[1–2 lines on valuation & modelling work]"],
    ["UTBSA", "Director of Events", "2025 – Apr 2026", "[1–2 lines on scope and outcomes]"],
    ["Rotman International Trading Competition", "Competitor", "[Dates]", "[1–2 lines on algo / market-making cases]"],
  ];
  return (
    <PageShell wp={WAYPOINTS[1]} onNav={onNav}>
      <p className="ep-eyebrow ep-mono">CAMP I — THE PAPERWORK</p>
      <div className="ep-row-between">
        <h1>Resume</h1>
        <StubButton hint="LINK YOUR RESUME PDF HERE">Download PDF</StubButton>
      </div>

      <h2 className="ep-h2">Education</h2>
      <div className="ep-card">
        <div className="ep-row-between">
          <div>
            <strong>University of Toronto — Rotman Commerce</strong>
            <p className="ep-sub">BCom, Finance &amp; Economics · Data Science focus</p>
          </div>
          <span className="ep-mono ep-sub">Expected 2028</span>
        </div>
      </div>

      <h2 className="ep-h2">Experience</h2>
      {rows.map(([org, role, when, blurb]) => (
        <div className="ep-card" key={org}>
          <div className="ep-row-between">
            <div><strong>{org}</strong><p className="ep-sub">{role}</p></div>
            <span className="ep-mono ep-sub">{when}</span>
          </div>
          <p className="ep-body">{blurb}</p>
        </div>
      ))}

      <h2 className="ep-h2">Skills</h2>
      <div className="ep-chips">
        <span>Python</span><span>C++</span><span>Excel</span><span>Valuation / DCF</span>
        <span>Fixed income</span><span>Stat &amp; econometrics</span><span>[Add more]</span>
      </div>
    </PageShell>
  );
}

function ProjectsPage({ onNav }) {
  const projects = [
    ["Salesforce (CRM) equity pitch", "DCF, exit multiples, buyback forecasting", ["Equity research", "Valuation"]],
    ["MAXSER portfolio replication", "Predictive regressions after Welch–Goyal (2008)", ["Data science", "Portfolio theory"]],
    ["WLP4 → ARM64 compiler", "Full code generator in C++, pointers to procedure calls", ["C++", "Systems"]],
    ["Macro paper-trading thesis", "Geopolitical risk via Treasuries, gold, oil options", ["Macro", "Trading"]],
  ];
  return (
    <PageShell wp={WAYPOINTS[2]} onNav={onNav}>
      <p className="ep-eyebrow ep-mono">CAMP II — WORK ON THE WALL</p>
      <h1>Projects</h1>
      <p className="ep-lede">Selected work across markets, data, and code. [Swap in your own set.]</p>
      <div className="ep-grid-2 ep-gap-lg">
        {projects.map(([title, blurb, tags]) => (
          <div className="ep-card ep-project" key={title}>
            <Placeholder label="COVER · 16:9" ratio="16 / 9" />
            <h3>{title}</h3>
            <p className="ep-body">{blurb}</p>
            <div className="ep-chips">{tags.map((t) => <span key={t}>{t}</span>)}</div>
            <StubButton variant="ep-btn-outline" hint="LINK THE WRITE-UP HERE">View details</StubButton>
          </div>
        ))}
      </div>
    </PageShell>
  );
}

function ContactPage({ onNav }) {
  return (
    <PageShell wp={WAYPOINTS[3]} onNav={onNav}>
      <p className="ep-eyebrow ep-mono">SUMMIT — 8,849 M · YOU MADE IT</p>
      <h1>Let's talk.</h1>
      <p className="ep-lede">
        Recruiting for markets-facing internships — always happy to chat about trading, public
        markets, or a role you think I'd be a fit for.
      </p>
      <div className="ep-btn-row">
        <StubButton hint="WIRE TO mailto:you@…">Email me</StubButton>
        <StubButton variant="ep-btn-outline" hint="ADD YOUR URL">LinkedIn</StubButton>
        <StubButton variant="ep-btn-outline" hint="ADD YOUR URL">GitHub</StubButton>
      </div>
      <div className="ep-grid-2 ep-gap-lg" style={{ marginTop: "2.5rem" }}>
        <Placeholder label="SUMMIT PHOTO · 3:2" ratio="3 / 2" />
        <div className="ep-card">
          <h3>Quick note</h3>
          <p className="ep-body">[Optional: office hours, response time, what you're currently exploring — or drop a simple contact form here later.]</p>
        </div>
      </div>
    </PageShell>
  );
}

const PAGES = { about: AboutPage, resume: ResumePage, projects: ProjectsPage, contact: ContactPage };

// Must match the .ep-modal-out / .ep-modal-overlay.is-closing animation duration in CSS below.
const MODAL_CLOSE_MS = 320;

// Loading screen timing — also interpolated into the CSS animation durations below,
// so JS and CSS can't drift out of sync.
const LOADING_MS = 2200;         // minimum time the loader is shown
const LOADER_FADE_MS = 500;      // loader fade-out duration once loading completes
const ROTATE_LEAD_MS = 450;      // passive rotation arms this long before the loader finishes

/* ============================================================
   App
   ============================================================ */
export default function App() {
  const mountRef = useRef(null);
  const apiRef = useRef(null);
  const tooltipRef = useRef(null);
  const pageRef = useRef(null);
  const audioRef = useRef(null);
  const closeTimerRef = useRef(null);
  const [page, setPage] = useState(null);
  const [closing, setClosing] = useState(false);
  const [hoverKey, setHoverKey] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [showLoader, setShowLoader] = useState(true);
  const [musicOn, setMusicOn] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dayMode, setDayMode] = useState(false);
  const [rotationOn, setRotationOn] = useState(true);
  const [snowOn, setSnowOn] = useState(true);

  useEffect(() => { pageRef.current = page; }, [page]);
  useEffect(() => () => clearTimeout(closeTimerRef.current), []);

  // Loading screen: hold passive rotation off until just before it finishes,
  // then fade the loader out and let the rest of the site come alive.
  useEffect(() => {
    const rotateTimer = setTimeout(() => {
      apiRef.current && apiRef.current.setIdleEnabled(true);
    }, Math.max(0, LOADING_MS - ROTATE_LEAD_MS));
    const doneTimer = setTimeout(() => setLoaded(true), LOADING_MS);
    const unmountTimer = setTimeout(() => setShowLoader(false), LOADING_MS + LOADER_FADE_MS);
    return () => { clearTimeout(rotateTimer); clearTimeout(doneTimer); clearTimeout(unmountTimer); };
  }, []);

  const toggleMusic = useCallback(() => {
    if (!loaded) return;
    setMusicOn((v) => !v);
  }, [loaded]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (musicOn && loaded) audio.play().catch(() => {});
    else audio.pause();
  }, [musicOn, loaded]);

  useEffect(() => {
    const api = buildScene(mountRef.current, {
      isPaused: () => pageRef.current !== null,
      onHover: (key) => setHoverKey(key),
      onSelect: (key) => setPage(key),
      onAnchor: (x, y) => {
        if (tooltipRef.current) {
          tooltipRef.current.style.transform = `translate(-50%, -110%) translate(${x}px, ${y}px)`;
        }
      },
    });
    apiRef.current = api;
    return () => api.dispose();
  }, []);

  // Push the dropdown settings into the 3D scene
  useEffect(() => { apiRef.current && apiRef.current.setDayMode(dayMode); }, [dayMode]);
  useEffect(() => { apiRef.current && apiRef.current.setRotationEnabled(rotationOn); }, [rotationOn]);
  useEffect(() => { apiRef.current && apiRef.current.setSnowEnabled(snowOn); }, [snowOn]);

  // Settings dropdown: close on any outside interaction (canvas, waypoints...) or Escape
  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e) => {
      if (!(e.target instanceof Element) || !e.target.closest(".ep-settings")) setSettingsOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setSettingsOpen(false); };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [settingsOpen]);

  const nav = useCallback((key) => {
    setSettingsOpen(false);
    setHoverKey(null);
    apiRef.current && apiRef.current.setHighlight(null);
    if (key === null) {
      // Keep the modal mounted while it plays its closing tween, then unmount.
      setClosing(true);
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = setTimeout(() => {
        setPage(null);
        setClosing(false);
      }, MODAL_CLOSE_MS);
    } else {
      clearTimeout(closeTimerRef.current);
      setClosing(false);
      setPage(key);
    }
  }, []);

  useEffect(() => {
    if (!page) return;
    const onKey = (e) => { if (e.key === "Escape") nav(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, nav]);

  const hoverWp = hoverKey && WAYPOINTS.find((w) => w.key === hoverKey);
  const Page = page ? PAGES[page] : null;

  return (
    <div className={`ep-root ${dayMode ? "ep-day" : ""}`}>
      <style>{CSS}</style>

      {/* Loading screen */}
      {showLoader && (
        <div className={`ep-loader ${loaded ? "is-done" : ""}`} aria-hidden={loaded}>
          <div className="ep-loader-inner">
            <h1 className="ep-name">
              <span className="ep-name-first">ERIC</span>
              <span className="ep-name-last">ZHANG</span>
            </h1>
            <p className="ep-mono ep-loader-status">PREPARING THE ASCENT…</p>
            <div className="ep-loader-bar"><div className="ep-loader-bar-fill" /></div>
          </div>
        </div>
      )}

      {/* Settings dropdown (top-right): music, sunset mode, rotation, snowfall.
          Music: drop a track at public/ambient.mp3 (or change the src below) to wire it up. */}
      <div className="ep-settings">
        <button
          className={`ep-set-btn ${settingsOpen ? "is-open" : ""}`}
          onClick={() => setSettingsOpen((v) => !v)}
          aria-expanded={settingsOpen}
          aria-label="Settings"
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="2" y1="4" x2="14" y2="4" />
              <line x1="2" y1="8" x2="14" y2="8" />
              <line x1="2" y1="12" x2="14" y2="12" />
            </g>
            <g fill="currentColor" stroke="none">
              <circle cx="10.2" cy="4" r="2" />
              <circle cx="5.2" cy="8" r="2" />
              <circle cx="11.4" cy="12" r="2" />
            </g>
          </svg>
        </button>
        <div className={`ep-set-panel ${settingsOpen ? "is-open" : ""}`} role="group" aria-label="Settings" aria-hidden={!settingsOpen}>
          <p className="ep-mono ep-set-title">SETTINGS</p>
          <SettingRow label="Music" on={musicOn} disabled={!loaded} onToggle={toggleMusic} />
          <SettingRow label="Sunset mode" on={dayMode} onToggle={() => setDayMode((v) => !v)} />
          <SettingRow label="Rotation" on={rotationOn} onToggle={() => setRotationOn((v) => !v)} />
          <SettingRow label="Snowfall" on={snowOn} onToggle={() => setSnowOn((v) => !v)} />
        </div>
        <audio ref={audioRef} loop preload="none" src="/ambient.mp3" />
      </div>

      {/* 3D expedition map */}
      <div className={`ep-stage ${page ? "ep-stage-blurred" : ""}`} aria-hidden={!!page}>
        <div ref={mountRef} className="ep-canvas" />

        {/* Wordmark */}
        <div className="ep-brand">
          <h1 className="ep-name">
            <span className="ep-name-first">ERIC</span>
            <span className="ep-name-last">ZHANG</span>
          </h1>
          <p className="ep-mono ep-tag">FINANCE · MARKETS · TORONTO — PORTFOLIO EXPEDITION</p>
        </div>

        {/* Waypoint legend (also keyboard-accessible nav) */}
        <nav className="ep-legend" aria-label="Waypoints">
          {WAYPOINTS.map((w) => (
            <button
              key={w.key}
              className={`ep-legend-item ${hoverKey === w.key ? "is-hot" : ""}`}
              onClick={() => nav(w.key)}
              onMouseEnter={() => apiRef.current && apiRef.current.setHighlight(w.key)}
              onMouseLeave={() => apiRef.current && apiRef.current.setHighlight(null)}
            >
              <span className="ep-mono">{w.camp.toUpperCase()} · {w.alt}</span>
              <strong>{w.name}</strong>
            </button>
          ))}
        </nav>

        {/* Controls hint + zoom buttons */}
        <p className="ep-hint ep-mono">DRAG TO PIVOT · SCROLL TO ZOOM · CLICK A LIT WAYPOINT</p>
        <div className="ep-zoom">
          <button aria-label="Zoom in" onClick={() => apiRef.current && apiRef.current.zoomBy(0.82)}>+</button>
          <button aria-label="Zoom out" onClick={() => apiRef.current && apiRef.current.zoomBy(1.22)}>−</button>
        </div>

        {/* Hover tooltip over the 3D object */}
        {hoverWp && !page && (
          <div ref={tooltipRef} className="ep-tooltip" role="status">
            <span className="ep-mono">{hoverWp.camp.toUpperCase()} · ALT {hoverWp.alt}</span>
            <strong>{hoverWp.name}</strong>
            <em className="ep-mono">CLICK TO OPEN →</em>
          </div>
        )}
      </div>

      {/* Sub-page modal: glass panel over the blurred mountain */}
      {Page && (
        <div
          className={`ep-modal-overlay ${closing ? "is-closing" : ""}`}
          onClick={(e) => { if (e.target === e.currentTarget) nav(null); }}
        >
          <div className={`ep-modal ${closing ? "is-closing" : ""}`} role="dialog" aria-modal="true">
            <button className="ep-modal-close" aria-label="Close" onClick={() => nav(null)}>×</button>
            <Page onNav={nav} />
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Styles
   ============================================================ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,700&family=IBM+Plex+Mono:wght@400;500&family=Instrument+Sans:wght@400;500;600&display=swap');

:root {
  --night: #0a1322;
  --glacier: #e9f1f8;
  --lantern: #ffb454;
  --paper: #f4f7fa;
  --ink: #16202c;
  --sub: #5a6b7e;
  --line: #d3dce6;
  --accent: #d97a1f;
  --display: "Bricolage Grotesque", "Avenir Next", "Segoe UI", sans-serif;
  --body: "Instrument Sans", "Helvetica Neue", Arial, sans-serif;
  --mono: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
.ep-root { font-family: var(--body); color: var(--ink); min-height: 100vh; background: var(--night);
  /* Overlay (on-stage) UI palette — flipped by .ep-day in sunset mode */
  --ui-text: var(--glacier);
  --ui-panel: rgba(10, 19, 34, 0.55);
  --ui-panel-strong: rgba(10, 19, 34, 0.78);
  --ui-border: rgba(233, 241, 248, 0.16);
  --ui-accent: var(--lantern); }
.ep-root.ep-day {
  --ui-text: #253140;
  --ui-panel: rgba(255, 250, 243, 0.55);
  --ui-panel-strong: rgba(255, 250, 243, 0.82);
  --ui-border: rgba(37, 49, 64, 0.22);
  --ui-accent: #2f6fbf; }
.ep-mono { font-family: var(--mono); letter-spacing: 0.12em; font-size: 0.68rem; }

/* ---------- Stage ---------- */
.ep-stage { position: fixed; inset: 0; overflow: hidden; filter: blur(0px) brightness(1); transition: filter 0.4s ease; }
.ep-stage.ep-stage-blurred { filter: blur(16px) brightness(0.55) saturate(1.15); pointer-events: none; }
.ep-canvas, .ep-canvas canvas { position: absolute; inset: 0; width: 100%; height: 100%; }

.ep-brand { position: absolute; top: 2rem; left: 2rem; color: var(--ui-text); pointer-events: none;
  text-align: left; animation: ep-fade 0.9s ease both; transition: color .6s ease; }
.ep-name { font-family: var(--display); letter-spacing: 0.02em; line-height: 0.92; text-align: left;
  display: flex; flex-direction: row; align-items: baseline; flex-wrap: wrap; gap: 0.55rem; }
.ep-name-first, .ep-name-last { font-size: clamp(2.6rem, 6vw, 4.6rem); color: var(--ui-text);
  transition: color .6s ease; }
.ep-name-first { font-weight: 700; }
.ep-name-last { font-weight: 100; }
.ep-tag { margin-top: 0.55rem; opacity: 0.75; }

.ep-legend { position: absolute; left: 2rem; bottom: 2rem; display: flex; flex-direction: column;
  gap: 0.4rem; animation: ep-fade 0.9s 0.15s ease both; }
.ep-legend-item { display: flex; flex-direction: column; align-items: flex-start; gap: 0.12rem;
  background: var(--ui-panel); border: 1px solid var(--ui-border);
  color: var(--ui-text); padding: 0.5rem 0.8rem; border-radius: 10px; cursor: pointer;
  backdrop-filter: blur(6px); text-align: left;
  transition: border-color .15s, transform .15s, background-color .6s ease, color .6s ease; }
.ep-legend-item .ep-mono { opacity: 0.6; }
.ep-legend-item strong { font-family: var(--display); font-size: 0.95rem; font-weight: 600; }
.ep-legend-item:hover, .ep-legend-item.is-hot { border-color: var(--ui-accent); transform: translateX(3px); }
.ep-legend-item:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 2px; }

/* the hint sits over dark terrain in both themes, so it stays light with a soft halo */
.ep-hint { position: absolute; bottom: 1.4rem; left: 50%; transform: translateX(-50%);
  color: var(--glacier); opacity: 0.6; pointer-events: none; white-space: nowrap;
  text-shadow: 0 1px 6px rgba(8, 12, 20, 0.5); }
.ep-zoom { position: absolute; right: 1.6rem; bottom: 1.6rem; display: flex; flex-direction: column; gap: 0.4rem; }
.ep-zoom button { width: 2.4rem; height: 2.4rem; border-radius: 50%; border: 1px solid var(--ui-border);
  background: var(--ui-panel); color: var(--ui-text); font-size: 1.15rem; cursor: pointer; backdrop-filter: blur(6px);
  transition: border-color .15s, background-color .6s ease, color .6s ease; }
.ep-zoom button:hover { border-color: var(--ui-accent); }
.ep-zoom button:focus-visible { outline: 2px solid var(--ui-accent); }

.ep-tooltip { position: absolute; top: 0; left: 0; pointer-events: none; display: flex;
  flex-direction: column; gap: 0.15rem; padding: 0.6rem 0.85rem; border-radius: 10px;
  background: var(--ui-panel-strong); border: 1px solid var(--ui-accent);
  color: var(--ui-text); box-shadow: 0 8px 28px rgba(0,0,0,0.45); animation: ep-pop 0.16s ease both; }
.ep-tooltip .ep-mono { color: var(--ui-accent); }
.ep-tooltip strong { font-family: var(--display); font-size: 1.05rem; font-weight: 700; }
.ep-tooltip em { font-style: normal; opacity: 0.6; font-size: 0.6rem; }

/* ---------- Loading screen ---------- */
.ep-loader { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center;
  justify-content: center; background: var(--night); opacity: 1;
  transition: opacity ${LOADER_FADE_MS}ms ease; }
.ep-loader.is-done { opacity: 0; pointer-events: none; }
.ep-loader-inner { display: flex; flex-direction: column; align-items: center; gap: 1.15rem; }
.ep-loader-inner .ep-name { justify-content: center; }
.ep-loader-status { color: var(--glacier); opacity: 0.55; }
.ep-loader-bar { width: 220px; height: 3px; border-radius: 3px; background: rgba(233, 241, 248, 0.15); overflow: hidden; }
.ep-loader-bar-fill { height: 100%; width: 0%; background: var(--lantern); border-radius: inherit;
  animation: ep-load-fill ${LOADING_MS}ms cubic-bezier(.3, 0, .2, 1) forwards; }
@keyframes ep-load-fill { from { width: 0%; } to { width: 100%; } }

/* ---------- Settings dropdown (top-right) ---------- */
.ep-settings { position: fixed; top: 2rem; right: 2rem; z-index: 25; display: flex;
  flex-direction: column; align-items: flex-end; animation: ep-fade 0.9s ease both; }
.ep-set-btn { width: 2.4rem; height: 2.4rem; border-radius: 50%; border: 1px solid var(--ui-border);
  background: var(--ui-panel); color: var(--ui-text); cursor: pointer; backdrop-filter: blur(6px);
  display: grid; place-items: center;
  transition: border-color .15s, transform .25s ease, background-color .6s ease, color .6s ease; }
.ep-set-btn:hover, .ep-set-btn.is-open { border-color: var(--ui-accent); }
.ep-set-btn.is-open { transform: rotate(90deg); }
.ep-set-btn:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 2px; }
.ep-set-panel { position: absolute; top: 3.1rem; right: 0; width: 13.5rem;
  padding: 0.8rem 0.9rem 0.4rem; border-radius: 14px; border: 1px solid var(--ui-border);
  background: var(--ui-panel-strong); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.35);
  opacity: 0; transform: translateY(-8px) scale(0.97); transform-origin: top right; pointer-events: none;
  transition: opacity .24s ease, transform .24s cubic-bezier(.2, .9, .3, 1),
    background-color .6s ease, border-color .6s ease; }
.ep-set-panel.is-open { opacity: 1; transform: none; pointer-events: auto; }
.ep-set-title { color: var(--ui-text); opacity: 0.55; margin-bottom: 0.35rem; transition: color .6s ease; }
.ep-set-row { width: 100%; display: flex; align-items: center; justify-content: space-between;
  gap: 0.8rem; background: none; border: none; border-top: 1px solid var(--ui-border);
  padding: 0.55rem 0.1rem; cursor: pointer; color: var(--ui-text);
  transition: color .6s ease, border-color .6s ease; }
.ep-set-row:nth-of-type(1) { border-top: none; }
.ep-set-row:disabled { opacity: 0.45; cursor: default; }
.ep-set-row:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 1px; border-radius: 8px; }
.ep-set-label { font-family: var(--body); font-size: 0.82rem; font-weight: 500; }
.ep-set-switch { position: relative; flex: none; width: 2.05rem; height: 1.15rem; border-radius: 999px;
  background: var(--ui-border); transition: background-color .2s ease; }
.ep-set-knob { position: absolute; top: 0.14rem; left: 0.14rem; width: 0.87rem; height: 0.87rem;
  border-radius: 50%; background: var(--ui-text);
  transition: transform .22s cubic-bezier(.3, .9, .4, 1.2), background-color .6s ease; }
.ep-set-row.is-on .ep-set-switch { background: var(--ui-accent); }
.ep-set-row.is-on .ep-set-knob { transform: translateX(0.9rem); background: #fff; }

/* ---------- Sub-page modal (glass morphism over the blurred mountain) ---------- */
.ep-modal-overlay { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center;
  justify-content: center; padding: clamp(1rem, 4vw, 3rem); background: rgba(6, 11, 20, 0.45);
  animation: ep-overlay-in 0.38s ease both; }
.ep-modal-overlay.is-closing { animation: ep-overlay-out ${MODAL_CLOSE_MS}ms ease both; }

.ep-modal { position: relative; width: min(920px, 100%); max-height: min(86vh, 920px);
  overflow-y: auto; border-radius: 22px; background: rgba(18, 30, 48, 0.55);
  border: 1px solid rgba(233, 241, 248, 0.18);
  box-shadow: 0 30px 90px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.07);
  backdrop-filter: blur(26px) saturate(150%); -webkit-backdrop-filter: blur(26px) saturate(150%);
  animation: ep-modal-in 0.38s cubic-bezier(.2, .9, .25, 1) both;
  /* Re-theme the shared page/card/button styles to sit on dark glass instead of white paper.
     color is set explicitly here (not just the --ink variable) because headings inherit the
     computed color value, not the variable, so redefining --ink alone would not reach them. */
  --paper: transparent; --ink: var(--glacier); --sub: rgba(233, 241, 248, 0.68);
  --line: rgba(233, 241, 248, 0.18); --card-bg: rgba(233, 241, 248, 0.06); color: var(--ink); }
.ep-modal.is-closing { animation: ep-modal-out ${MODAL_CLOSE_MS}ms cubic-bezier(.4, 0, 1, 1) both; }

.ep-modal .ep-page { background: transparent; min-height: 0; padding: clamp(1.4rem, 4vw, 2.4rem); animation: none; }
.ep-modal .ep-contours { stroke: rgba(233, 241, 248, 0.18); }
.ep-modal .ep-ph span { background: rgba(18, 30, 48, 0.85); }
.ep-modal .ep-btn-outline { color: var(--glacier); border-color: rgba(233, 241, 248, 0.4); }
.ep-modal .ep-btn-ghost { color: rgba(233, 241, 248, 0.7); }
.ep-modal .ep-btn-ghost:hover { color: var(--glacier); border-color: var(--glacier); }

.ep-modal-close { position: absolute; top: 1rem; right: 1rem; z-index: 1; width: 2.2rem; height: 2.2rem;
  border-radius: 50%; border: 1px solid rgba(233, 241, 248, 0.25); background: rgba(10, 19, 34, 0.5);
  color: var(--glacier); font-size: 1.3rem; line-height: 1; cursor: pointer; backdrop-filter: blur(6px); }
.ep-modal-close:hover { border-color: var(--lantern); color: var(--lantern); }
.ep-modal-close:focus-visible { outline: 2px solid var(--lantern); outline-offset: 2px; }

/* Sunset (light) mode: pages go white, accent shifts orange → blue */
.ep-day .ep-modal-overlay { background: rgba(94, 63, 38, 0.3); }
.ep-day .ep-modal { background: rgba(255, 252, 247, 0.82); border-color: rgba(37, 49, 64, 0.15);
  box-shadow: 0 30px 90px rgba(74, 46, 22, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.65);
  --ink: #1c2733; --sub: #5c6b7c; --line: #d9dee6; --card-bg: rgba(255, 255, 255, 0.75);
  --accent: #2f6fbf; }
.ep-day .ep-modal .ep-contours { stroke: rgba(28, 39, 51, 0.16); }
.ep-day .ep-modal .ep-ph span { background: rgba(255, 255, 255, 0.9); }
.ep-day .ep-modal .ep-btn-outline { color: var(--ink); border-color: rgba(28, 39, 51, 0.45); }
.ep-day .ep-modal .ep-btn-ghost { color: var(--sub); }
.ep-day .ep-modal .ep-btn-ghost:hover { color: var(--ink); border-color: var(--ink); }
.ep-day .ep-modal .ep-btn-primary { box-shadow: 0 4px 14px rgba(47, 111, 191, 0.3); }
.ep-day .ep-modal-close { background: rgba(255, 255, 255, 0.65); color: #1c2733; border-color: rgba(28, 39, 51, 0.25); }
.ep-modal-overlay, .ep-modal, .ep-modal-close { transition: background-color .6s ease, border-color .6s ease, color .6s ease; }
.ep-modal .ep-card, .ep-modal .ep-chips span, .ep-modal h1, .ep-modal .ep-h2, .ep-modal h3,
.ep-modal .ep-lede, .ep-modal .ep-body, .ep-modal .ep-sub, .ep-modal .ep-way, .ep-modal .ep-eyebrow {
  transition: background-color .6s ease, color .6s ease, border-color .6s ease; }
.ep-modal .ep-btn { transition: transform .12s, box-shadow .12s,
  background-color .6s ease, color .6s ease, border-color .6s ease; }

@keyframes ep-overlay-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes ep-overlay-out { from { opacity: 1; } to { opacity: 0; } }
@keyframes ep-modal-in { from { opacity: 0; transform: translateY(48px) scale(0.98); } to { opacity: 1; transform: none; } }
@keyframes ep-modal-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(-40px) scale(0.98); } }

/* ---------- Pages ---------- */
.ep-page { position: relative; min-height: 100vh; background: var(--paper);
  padding: 1.6rem clamp(1.2rem, 6vw, 5rem) 3rem; animation: ep-rise 0.4s ease both; overflow: hidden; }
.ep-contours { position: absolute; top: -20px; right: -30px; width: min(340px, 45vw); opacity: 0.5;
  stroke: var(--line); stroke-width: 1.4; pointer-events: none; }
.ep-page-top { display: flex; justify-content: space-between; align-items: center; gap: 1rem;
  padding-bottom: 1.4rem; border-bottom: 1px solid var(--line); position: relative; z-index: 1; }
.ep-way { color: var(--sub); }
.ep-page-body { max-width: 62rem; margin: 0 auto; padding-top: 2.6rem; position: relative; z-index: 1; }
.ep-page-foot { max-width: 62rem; margin: 3.5rem auto 0; padding-top: 1.2rem;
  border-top: 1px solid var(--line); display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }

h1 { font-family: var(--display); font-size: clamp(2.3rem, 5.5vw, 3.8rem); font-weight: 700;
  letter-spacing: -0.01em; margin: 0.5rem 0 1.4rem; }
.ep-h2 { font-family: var(--display); font-size: 1.25rem; font-weight: 600; margin: 2.4rem 0 0.9rem; }
h3 { font-family: var(--display); font-size: 1.1rem; font-weight: 600; margin: 0.9rem 0 0.35rem; }
.ep-eyebrow { color: var(--accent); }
.ep-lede { font-size: 1.12rem; line-height: 1.65; color: var(--ink); max-width: 40rem; margin-bottom: 1rem; }
.ep-body { line-height: 1.65; color: var(--sub); margin: 0.5rem 0 1rem; }
.ep-sub { color: var(--sub); font-size: 0.9rem; margin-top: 0.15rem; }

.ep-grid-2 { display: grid; grid-template-columns: 1fr 1.35fr; gap: 2.2rem; align-items: start; }
.ep-gap-lg { gap: 1.6rem; grid-template-columns: 1fr 1fr; }
.ep-row-between { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }

.ep-card { border: 1px solid var(--line); border-radius: 14px; padding: 1.1rem 1.3rem;
  background: var(--card-bg, #fff); margin-bottom: 0.8rem; }
.ep-project { display: flex; flex-direction: column; }
.ep-project .ep-btn { align-self: flex-start; margin-top: auto; }

.ep-ph { position: relative; border: 1.5px dashed var(--line); border-radius: 14px; width: 100%;
  display: grid; place-items: center; color: var(--sub); background:
    linear-gradient(to top right, transparent calc(50% - 0.6px), var(--line) calc(50% - 0.6px), var(--line) calc(50% + 0.6px), transparent calc(50% + 0.6px)),
    linear-gradient(to bottom right, transparent calc(50% - 0.6px), var(--line) calc(50% - 0.6px), var(--line) calc(50% + 0.6px), transparent calc(50% + 0.6px)); }
.ep-ph span { font-family: var(--mono); font-size: 0.66rem; letter-spacing: 0.14em;
  background: var(--paper); padding: 0.25rem 0.55rem; border-radius: 6px; }

.ep-chips { display: flex; flex-wrap: wrap; gap: 0.45rem; margin: 0.9rem 0; }
.ep-chips span { font-family: var(--mono); font-size: 0.66rem; letter-spacing: 0.08em;
  border: 1px solid var(--line); border-radius: 999px; padding: 0.3rem 0.7rem; color: var(--sub); }

.ep-btn { font-family: var(--body); font-weight: 600; font-size: 0.9rem; border-radius: 10px;
  padding: 0.6rem 1.15rem; cursor: pointer; border: 1px solid transparent; transition: transform .12s, box-shadow .12s; }
.ep-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ep-btn:hover { transform: translateY(-1px); }
.ep-btn-primary { background: var(--accent); color: #fff; box-shadow: 0 4px 14px rgba(217,122,31,0.3); }
.ep-btn-outline { background: transparent; color: var(--ink); border-color: var(--ink); }
.ep-btn-ghost { background: transparent; color: var(--sub); border-color: var(--line); }
.ep-btn-ghost:hover { color: var(--ink); border-color: var(--ink); }
.ep-btn-row { display: flex; gap: 0.7rem; flex-wrap: wrap; margin-top: 1.2rem; }
.ep-stub { display: inline-flex; align-items: center; gap: 0.55rem; flex-wrap: wrap; }
.ep-stub-note { font-style: normal; color: var(--accent); font-size: 0.62rem; animation: ep-pop 0.2s ease both; }

@keyframes ep-fade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes ep-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
@keyframes ep-pop { from { opacity: 0; } to { opacity: 1; } }

@media (max-width: 720px) {
  .ep-grid-2, .ep-gap-lg { grid-template-columns: 1fr; }
  .ep-brand { top: 1.2rem; left: 1.2rem; }
  .ep-legend { left: 1.2rem; bottom: 4.4rem; }
  .ep-hint { display: none; }
  .ep-settings { top: 1.2rem; right: 1.2rem; }
}
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
`;
