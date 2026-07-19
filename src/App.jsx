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
  scene.fog = new THREE.Fog(NIGHT, 130, 330);

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

  function placeCamera() {
    const sp = Math.sin(POLAR), cp = Math.cos(POLAR);
    camera.position.set(
      pivot.x + radius * Math.sin(azimuth) * sp,
      pivot.y + radius * cp,
      pivot.z + radius * Math.cos(azimuth) * sp
    );
    camera.lookAt(pivot);
  }

  /* Lights */
  scene.add(new THREE.HemisphereLight(0x2a3d5c, 0x090d14, 0.85));
  const moonLight = new THREE.DirectionalLight(0xbfd4ef, 0.95);
  moonLight.position.set(-90, 130, 110);
  scene.add(moonLight);
  const alpenglow = new THREE.DirectionalLight(0xf2a0b0, 0.38);
  alpenglow.position.set(70, 60, -120);
  scene.add(alpenglow);

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
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 900),
    new THREE.MeshStandardMaterial({ color: 0x0d1726, roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.25;
  scene.add(floor);

  /* Stars + moon */
  {
    const starPos = [];
    for (let i = 0; i < 380; i++) {
      const a = hash2(i, 7) * Math.PI * 2, e = 0.12 + hash2(i, 13) * 1.25, R = 430;
      starPos.push(R * Math.cos(e) * Math.cos(a), 30 + R * Math.sin(e), R * Math.cos(e) * Math.sin(a));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(starPos, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xdfe9f5, size: 1.7, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.9
    })));
    const moon = new THREE.Mesh(
      new THREE.SphereGeometry(9, 20, 20),
      new THREE.MeshBasicMaterial({ color: 0xe8f0fa, fog: false })
    );
    moon.position.set(-190, 150, 230);
    scene.add(moon);
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
      const m = new THREE.Mesh(o.geometry, new THREE.MeshBasicMaterial({ color: LANTERN, side: THREE.BackSide }));
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
  function loop() {
    raf = requestAnimationFrame(loop);
    if (hooks.isPaused()) return;
    const t = clock.getElapsedTime();

    if (!dragging) {
      azimuth += azVel; azVel *= 0.92;                       // inertia
      const idleFor = performance.now() - lastInteractionAt;
      if (!reduceMotion && idleEnabled && idleFor > IDLE_RESUME_MS) azimuth += 0.0011; // idle drift
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
    }
    // snowfall
    if (snowPts) {
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

  const nav = useCallback((key) => {
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
    <div className="ep-root">
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

      {/* Minimalist music player — drop a track at public/ambient.mp3 (or change the src below) to wire it up */}
      <div className="ep-player">
        <button
          className={`ep-player-btn ${musicOn ? "is-playing" : ""}`}
          onClick={toggleMusic}
          disabled={!loaded}
          aria-pressed={musicOn}
          aria-label={musicOn ? "Pause music" : "Play music"}
        >
          {musicOn ? (
            <span className="ep-player-bars"><span /><span /><span /></span>
          ) : (
            <span className="ep-player-play">▶</span>
          )}
        </button>
        <span className="ep-mono ep-player-label">AMBIENT</span>
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
.ep-root { font-family: var(--body); color: var(--ink); min-height: 100vh; background: var(--night); }
.ep-mono { font-family: var(--mono); letter-spacing: 0.12em; font-size: 0.68rem; }

/* ---------- Stage ---------- */
.ep-stage { position: fixed; inset: 0; overflow: hidden; filter: blur(0px) brightness(1); transition: filter 0.4s ease; }
.ep-stage.ep-stage-blurred { filter: blur(16px) brightness(0.55) saturate(1.15); pointer-events: none; }
.ep-canvas, .ep-canvas canvas { position: absolute; inset: 0; width: 100%; height: 100%; }

.ep-brand { position: absolute; top: 2rem; left: 2rem; color: var(--glacier); pointer-events: none;
  text-align: left; animation: ep-fade 0.9s ease both; }
.ep-name { font-family: var(--display); letter-spacing: 0.02em; line-height: 0.92; text-align: left;
  display: flex; flex-direction: row; align-items: baseline; flex-wrap: wrap; gap: 0.55rem; }
.ep-name-first, .ep-name-last { font-size: clamp(2.6rem, 6vw, 4.6rem); color: var(--glacier); }
.ep-name-first { font-weight: 700; }
.ep-name-last { font-weight: 300; }
.ep-tag { margin-top: 0.55rem; opacity: 0.75; }

.ep-legend { position: absolute; left: 2rem; bottom: 2rem; display: flex; flex-direction: column;
  gap: 0.4rem; animation: ep-fade 0.9s 0.15s ease both; }
.ep-legend-item { display: flex; flex-direction: column; align-items: flex-start; gap: 0.12rem;
  background: rgba(10, 19, 34, 0.55); border: 1px solid rgba(233, 241, 248, 0.16);
  color: var(--glacier); padding: 0.5rem 0.8rem; border-radius: 10px; cursor: pointer;
  backdrop-filter: blur(6px); text-align: left; transition: border-color .15s, transform .15s; }
.ep-legend-item .ep-mono { opacity: 0.6; }
.ep-legend-item strong { font-family: var(--display); font-size: 0.95rem; font-weight: 600; }
.ep-legend-item:hover, .ep-legend-item.is-hot { border-color: var(--lantern); transform: translateX(3px); }
.ep-legend-item:focus-visible { outline: 2px solid var(--lantern); outline-offset: 2px; }

.ep-hint { position: absolute; bottom: 1.4rem; left: 50%; transform: translateX(-50%);
  color: var(--glacier); opacity: 0.55; pointer-events: none; white-space: nowrap; }
.ep-zoom { position: absolute; right: 1.6rem; bottom: 1.6rem; display: flex; flex-direction: column; gap: 0.4rem; }
.ep-zoom button { width: 2.4rem; height: 2.4rem; border-radius: 50%; border: 1px solid rgba(233,241,248,0.25);
  background: rgba(10,19,34,0.6); color: var(--glacier); font-size: 1.15rem; cursor: pointer; backdrop-filter: blur(6px); }
.ep-zoom button:hover { border-color: var(--lantern); }
.ep-zoom button:focus-visible { outline: 2px solid var(--lantern); }

.ep-tooltip { position: absolute; top: 0; left: 0; pointer-events: none; display: flex;
  flex-direction: column; gap: 0.15rem; padding: 0.6rem 0.85rem; border-radius: 10px;
  background: rgba(10, 19, 34, 0.82); border: 1px solid var(--lantern);
  color: var(--glacier); box-shadow: 0 8px 28px rgba(0,0,0,0.45); animation: ep-pop 0.16s ease both; }
.ep-tooltip .ep-mono { color: var(--lantern); }
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

/* ---------- Music player ---------- */
.ep-player { position: fixed; top: 2rem; right: 2rem; z-index: 40; display: flex;
  align-items: center; gap: 0.6rem; animation: ep-fade 0.9s ease both; }
.ep-player-btn { width: 2.4rem; height: 2.4rem; border-radius: 50%; border: 1px solid rgba(233, 241, 248, 0.25);
  background: rgba(10, 19, 34, 0.6); color: var(--glacier); cursor: pointer; backdrop-filter: blur(6px);
  display: grid; place-items: center; transition: border-color .15s, opacity .15s; }
.ep-player-btn:hover:not(:disabled) { border-color: var(--lantern); }
.ep-player-btn:focus-visible { outline: 2px solid var(--lantern); outline-offset: 2px; }
.ep-player-btn:disabled { opacity: 0.4; cursor: default; }
.ep-player-btn.is-playing { border-color: var(--lantern); }
.ep-player-play { font-size: 0.65rem; transform: translateX(1px); }
.ep-player-bars { display: flex; align-items: flex-end; gap: 2px; height: 0.7rem; }
.ep-player-bars span { width: 2.5px; background: var(--lantern); border-radius: 1px;
  animation: ep-bars 0.8s ease-in-out infinite; }
.ep-player-bars span:nth-child(1) { height: 40%; animation-delay: -0.4s; }
.ep-player-bars span:nth-child(2) { height: 100%; animation-delay: -0.1s; }
.ep-player-bars span:nth-child(3) { height: 65%; animation-delay: -0.6s; }
@keyframes ep-bars { 0%, 100% { transform: scaleY(0.4); } 50% { transform: scaleY(1); } }
.ep-player-label { color: var(--glacier); opacity: 0.6; }

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
  .ep-player { top: 1.2rem; right: 1.2rem; }
  .ep-player-label { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
`;
