// world.js
// Procedural terrain + biomes + skybox + lighting.
//
// Design: a WorldConfig fully determines the scene. Regenerating the world
// swaps in a new root Group and disposes the old one, so "promptable world
// events" (Genie 3 phrasing) that change biome or seed mean rebuilding, while
// weather/lighting changes are live.

import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

// ────────────────────────────────────────────────────────────────────────────
// Deterministic PRNG so a given seed reproduces the same world
// ────────────────────────────────────────────────────────────────────────────
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Heightmap functions per terrain type
// ────────────────────────────────────────────────────────────────────────────
function makeHeightFn(cfg, rand) {
  const noise = createNoise2D(rand);
  const n = (x, y, f) => noise(x * f, y * f);

  // fractal brownian motion
  const fbm = (x, y, octaves, lac = 2.0, gain = 0.5, f0 = 0.005) => {
    let a = 1, f = f0, s = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      s += a * n(x, y, f);
      norm += a;
      a *= gain; f *= lac;
    }
    return s / norm;
  };

  switch (cfg.terrain) {
    case 'dunes': {
      // wind-aligned dunes: strong ridged noise in one direction + drift
      const windAngle = Math.PI * 0.35;
      const cosA = Math.cos(windAngle), sinA = Math.sin(windAngle);
      return (x, y) => {
        const u =  cosA * x + sinA * y;
        const v = -sinA * x + cosA * y;
        const base = fbm(x, y, 3, 2.0, 0.5, 0.004) * 4;
        const ridge = (1 - Math.abs(n(u * 0.015, v * 0.003, 1))) * 8;
        const chop = fbm(x, y, 4, 2.0, 0.5, 0.04) * 1.2;
        return base + ridge + chop;
      };
    }
    case 'canyon': {
      // a meandering river valley carved through rolling highlands
      return (x, y) => {
        const high = fbm(x, y, 5, 2.0, 0.5, 0.006) * 28 + 20;
        // river centerline
        const riverY = 40 * n(x, 0, 0.004);
        const dist = Math.abs(y - riverY);
        const valley = Math.max(0, 40 - dist);          // carves down where close to river
        const erosion = Math.max(0, 20 - dist * 0.4);
        return high - valley * 0.8 - erosion;
      };
    }
    case 'alpine': {
      // high-frequency rugged peaks
      return (x, y) => {
        const peaks = Math.pow(Math.abs(fbm(x, y, 6, 2.0, 0.55, 0.006)), 1.2) * 90;
        const detail = fbm(x, y, 4, 2.0, 0.5, 0.03) * 3;
        return peaks + detail;
      };
    }
    case 'urban': {
      // mostly flat; buildings handled as separate meshes
      return (x, y) => fbm(x, y, 3, 2.0, 0.5, 0.01) * 1.5;
    }
    case 'flat': {
      return (x, y) => fbm(x, y, 3, 2.0, 0.5, 0.01) * 1.2;
    }
    case 'rolling':
    default: {
      return (x, y) => {
        const big = fbm(x, y, 4, 2.0, 0.5, 0.005) * 12;
        const sm = fbm(x, y, 3, 2.0, 0.5, 0.03) * 1.5;
        return big + sm;
      };
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Ground colour per biome, modulated by snow/sand
// ────────────────────────────────────────────────────────────────────────────
function baseGroundColor(cfg) {
  const c = new THREE.Color();
  switch (cfg.ground) {
    case 'snow':    c.setHSL(0.58, 0.12, 0.86); break;
    case 'sand':    c.setHSL(0.10, 0.55, 0.60); break;
    case 'rock':    c.setHSL(0.07, 0.08, 0.38); break;
    case 'dirt':    c.setHSL(0.09, 0.30, 0.28); break;
    case 'asphalt': c.setHSL(0.60, 0.03, 0.18); break;
    default:        c.setHSL(0.30, 0.30, 0.45);
  }
  return c;
}

// ────────────────────────────────────────────────────────────────────────────
// Build terrain mesh with per-vertex colours
// ────────────────────────────────────────────────────────────────────────────
function buildTerrain(cfg) {
  const SIZE = 300;
  const SEG  = 150;   // smaller terrain, still smooth
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);

  const rand = mulberry32(cfg.seed | 0);
  const height = makeHeightFn(cfg, rand);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const base = baseGroundColor(cfg);
  const snowTint = new THREE.Color(0xf3f8ff);
  const rockTint = new THREE.Color(0x5c5850);
  const grassTint = new THREE.Color(0x3f6a3a);

  const minH = { v: Infinity }, maxH = { v: -Infinity };
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = height(x, z);
    pos.setY(i, h);
    if (h < minH.v) minH.v = h;
    if (h > maxH.v) maxH.v = h;
  }

  // slope & per-vertex colour: snow accumulates on low slopes and at altitude
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // approx slope by sampling neighbors
    const dx = height(x + 2, z) - y;
    const dz = height(x, z + 2) - y;
    const slope = Math.min(1, Math.sqrt(dx * dx + dz * dz) / 2);

    const c = base.clone();
    if (cfg.vegetation === 'dense' && slope < 0.35 && y > -2) {
      c.lerp(grassTint, 0.55);
    } else if (cfg.vegetation === 'moss' && slope < 0.4) {
      c.lerp(grassTint, 0.25);
    }
    if (cfg.terrain === 'alpine' || cfg.terrain === 'canyon') {
      if (slope > 0.35) c.lerp(rockTint, Math.min(1, (slope - 0.35) * 2));
    }

    // snow accumulation: more on flat high ground, influenced by cfg.snow
    const snowFactor = cfg.snow * Math.max(0, 1 - slope * 2.2)
                     * THREE.MathUtils.smoothstep(y, -5, 40);
    if (snowFactor > 0.05) c.lerp(snowTint, Math.min(1, snowFactor));

    // sand darkening in troughs for dune biome
    if (cfg.terrain === 'dunes') {
      const t = THREE.MathUtils.smoothstep((y - minH.v) / Math.max(1, (maxH.v - minH.v)), 0, 1);
      c.offsetHSL(0, 0, (t - 0.5) * 0.08);
    }

    colors[i * 3]     = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: cfg.ground === 'snow' ? 0.9 : cfg.ground === 'sand' ? 0.95 : 0.88,
    metalness: 0.0,
    flatShading: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  // expose height sampler for physics / spawn
  mesh.userData.heightAt = (x, z) => {
    if (Math.abs(x) > SIZE/2 - 1 || Math.abs(z) > SIZE/2 - 1) return 0;
    return height(x, z);
  };
  mesh.userData.extent = SIZE;
  return mesh;
}

// ────────────────────────────────────────────────────────────────────────────
// Vegetation (instanced cones for trees, cubes for buildings)
// ────────────────────────────────────────────────────────────────────────────
function buildVegetation(cfg, terrain) {
  const group = new THREE.Group();
  const rand = mulberry32((cfg.seed ^ 0x9e3779b1) | 0);
  const heightAt = terrain.userData.heightAt;
  const S = terrain.userData.extent / 2 - 10;

  if (cfg.vegetation === 'dense' || cfg.vegetation === 'sparse') {
    const count = cfg.vegetation === 'dense' ? 1800 : 350;
    const geo = new THREE.ConeGeometry(2.5, 10, 6);
    geo.translate(0, 5, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: cfg.ambientC < 0 ? 0x2e4a2a : 0x3b6b3a,
      roughness: 0.95, flatShading: true,
    });
    const inst = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    let placed = 0;
    for (let i = 0; i < count * 3 && placed < count; i++) {
      const x = (rand() - 0.5) * 2 * S;
      const z = (rand() - 0.5) * 2 * S;
      const y = heightAt(x, z);
      // skip steep slopes and underwater
      const dx = heightAt(x + 2, z) - y, dz = heightAt(x, z + 2) - y;
      const slope = Math.sqrt(dx * dx + dz * dz) / 2;
      if (slope > 0.4) continue;
      if (y < -1) continue;
      const scale = 0.7 + rand() * 0.9;
      s.set(scale, scale * (0.9 + rand() * 0.4), scale);
      q.setFromEuler(new THREE.Euler(0, rand() * Math.PI * 2, 0));
      m.compose(new THREE.Vector3(x, y, z), q, s);
      inst.setMatrixAt(placed++, m);
    }
    inst.count = placed;
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = true;
    group.add(inst);
  }

  if (cfg.terrain === 'urban') {
    // boxy buildings on a loose grid
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0x5a6170, roughness: 0.8, metalness: 0.1 });
    const count = 250;
    const inst = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const x = (rand() - 0.5) * 2 * S;
      const z = (rand() - 0.5) * 2 * S;
      const y = terrain.userData.heightAt(x, z);
      const w = 8 + rand() * 12;
      const d = 8 + rand() * 12;
      const h = 15 + rand() * 85;
      m.compose(
        new THREE.Vector3(x, y + h / 2, z),
        new THREE.Quaternion(),
        new THREE.Vector3(w, h, d),
      );
      inst.setMatrixAt(i, m);
    }
    inst.castShadow = true;
    inst.receiveShadow = true;
    group.add(inst);
  }

  return group;
}

// ────────────────────────────────────────────────────────────────────────────
// Sky & lighting — sun colour/angle from timeOfDay in [0, 1]
// ────────────────────────────────────────────────────────────────────────────
function buildSky() {
  // gradient-shader sky on a large sphere
  const uniforms = {
    uTop:    { value: new THREE.Color(0x0b1022) },
    uMid:    { value: new THREE.Color(0x213760) },
    uHorizon:{ value: new THREE.Color(0x5a6c82) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Color(0xffe6c2) },
    uHaze:   { value: 0.2 },
  };
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms,
    vertexShader: `
      varying vec3 vWorldPos;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform vec3 uTop, uMid, uHorizon, uSunCol;
      uniform vec3 uSunDir;
      uniform float uHaze;
      varying vec3 vWorldPos;
      void main(){
        vec3 v = normalize(vWorldPos);
        float h = clamp(v.y, -0.2, 1.0);
        vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.3, h));
        col = mix(col, uTop, smoothstep(0.3, 0.9, h));
        // sun glow
        float sd = max(0.0, dot(v, normalize(uSunDir)));
        col += uSunCol * pow(sd, 8.0) * 0.35;
        col += uSunCol * pow(sd, 64.0) * 1.2;
        // haze near horizon
        col = mix(col, uHorizon, uHaze * (1.0 - smoothstep(0.0, 0.2, h)));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    depthWrite: false,
  });
  const geo = new THREE.SphereGeometry(3000, 32, 16);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sky';
  return mesh;
}

function sunParams(tod) {
  // tod in [0, 1] with 0 = midnight, 0.5 = noon
  const angle = (tod - 0.25) * Math.PI * 2;  // sun rises at 0.25
  const altitude = Math.sin(angle);          // [-1, 1]
  const azimuth  = Math.cos(angle);
  const dir = new THREE.Vector3(azimuth, Math.max(-0.1, altitude), 0.3).normalize();

  // colour: night -> dawn -> day -> dusk
  let sun = new THREE.Color();
  const h = Math.max(0, altitude);
  if (h < 0.05) {
    sun.setHSL(0.08, 0.9, 0.45);     // deep orange near horizon
  } else if (h < 0.25) {
    sun.setHSL(0.1, 0.75, 0.55);     // warm
  } else {
    sun.setHSL(0.12, 0.4, 0.85);     // white-ish
  }
  const intensity = altitude > 0 ? 0.15 + altitude * 1.6 : 0.02;
  const ambient = altitude > 0 ? 0.25 + altitude * 0.55 : 0.12;

  const topCol = new THREE.Color().lerpColors(
    new THREE.Color(0x050505),
    new THREE.Color(0x3a3a3a),
    Math.max(0, altitude + 0.05),
  );
  const midCol = new THREE.Color().lerpColors(
    new THREE.Color(0x0c0c0c),
    new THREE.Color(0x6a6a6a),
    Math.max(0, altitude + 0.1),
  );
  const horCol = new THREE.Color().lerpColors(
    new THREE.Color(0x1a1028),
    new THREE.Color(0xf5b46b),
    Math.max(0, 1 - Math.abs(altitude - 0.05) * 2),
  );

  return { dir, sun, intensity, ambient, topCol, midCol, horCol };
}

// ────────────────────────────────────────────────────────────────────────────
// Top-level API
// ────────────────────────────────────────────────────────────────────────────
export class World {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.scene.add(this.root);

    // lights
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(1024, 1024);
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 400;
    const sc = this.sunLight.shadow.camera;
    sc.left = -160; sc.right = 160; sc.top = 160; sc.bottom = -160;
    this.sunLight.shadow.bias = -0.0005;
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);

    this.ambient = new THREE.HemisphereLight(0xaec6ff, 0x2b2620, 0.4);
    scene.add(this.ambient);

    this.sky = buildSky();
    scene.add(this.sky);

    this.fog = new THREE.FogExp2(0x9dadc3, 0.002);
    scene.add(new THREE.Object3D()); // placeholder
    scene.fog = this.fog;

    this.cfg = null;
    this.terrain = null;
    this.vegetation = null;
  }

  regenerate(cfg) {
    this.cfg = cfg;
    // wipe old terrain/vegetation
    this.root.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose?.();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose?.());
        else obj.material.dispose?.();
      }
    });
    while (this.root.children.length) this.root.remove(this.root.children[0]);

    this.terrain = buildTerrain(cfg);
    this.root.add(this.terrain);
    this.vegetation = buildVegetation(cfg, this.terrain);
    this.root.add(this.vegetation);

    this.updateLighting(cfg);
  }

  // call every frame OR whenever cfg.timeOfDay / fog changes
  updateLighting(cfg) {
    const p = sunParams(cfg.timeOfDay);
    this.sunLight.position.copy(p.dir).multiplyScalar(200);
    this.sunLight.target.position.set(0, 0, 0);
    this.sunLight.color.copy(p.sun);
    this.sunLight.intensity = p.intensity;
    this.ambient.intensity = p.ambient;

    this.sky.material.uniforms.uSunDir.value.copy(p.dir);
    this.sky.material.uniforms.uSunCol.value.copy(p.sun);
    this.sky.material.uniforms.uTop.value.copy(p.topCol);
    this.sky.material.uniforms.uMid.value.copy(p.midCol);
    this.sky.material.uniforms.uHorizon.value.copy(p.horCol);

    // fog density from visibility + precipitation
    const baseDensity = 2.0 / Math.max(300, cfg.visibility);
    const precipDensity = cfg.snow * 0.0015 + cfg.sand * 0.002 + cfg.rain * 0.0008 + cfg.fog * 0.01;
    this.fog.density = baseDensity + precipDensity;

    // tint fog toward sun color near horizon
    const fogCol = new THREE.Color().copy(p.horCol).multiplyScalar(0.9);
    if (cfg.sand > 0.1) fogCol.lerp(new THREE.Color(0xc4955a), cfg.sand * 0.8);
    if (cfg.snow > 0.1) fogCol.lerp(new THREE.Color(0xd9e6f7), cfg.snow * 0.7);
    this.fog.color.copy(fogCol);
  }

  heightAt(x, z) {
    return this.terrain?.userData.heightAt(x, z) ?? 0;
  }
}
