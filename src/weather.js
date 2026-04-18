// weather.js
// Weather = wind field + particle systems (snow / sand / rain).
//
// The wind field is read by both the particles (for advection) and by the
// drone (for aerodynamic drag & turbulence). Using a small analytic noise
// function keeps it cheap and deterministic for repeatable training.

import * as THREE from 'three';
import { createNoise3D } from 'simplex-noise';

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Wind field — prevailing direction + turbulent gusts via 3D noise
// ────────────────────────────────────────────────────────────────────────────
export class WindField {
  constructor(cfg) {
    const rand = mulberry32((cfg.seed ^ 0xABC12345) | 0);
    this.noiseU = createNoise3D(rand);
    this.noiseV = createNoise3D(rand);
    this.noiseW = createNoise3D(rand);
    this.setConfig(cfg);
    this.t = 0;
  }
  setConfig(cfg) {
    this.speed = cfg.wind;
    this.gust = cfg.gust;
    // prevailing direction from seed
    const a = (cfg.seed % 360) * Math.PI / 180;
    this.dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    // turbulence amplitude grows with gust
    this.turb = Math.max(0.5, (this.gust - this.speed)) * 0.6 + 0.5;
  }
  update(dt) { this.t += dt; }
  // sample wind velocity (m/s) at a world position
  sample(x, y, z, out) {
    out = out || new THREE.Vector3();
    const f = 0.02, tf = 0.12;
    const u = this.noiseU(x * f, y * f, this.t * tf);
    const v = this.noiseV(x * f, y * f, this.t * tf) * 0.4;  // smaller vertical
    const w = this.noiseW(x * f, z * f, this.t * tf);
    out.set(
      this.dir.x * this.speed + u * this.turb,
      v * this.turb,
      this.dir.z * this.speed + w * this.turb,
    );
    return out;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Generic point-sprite particle system advected by the wind field.
// We use BufferGeometry Points — simple, fast, and scales to ~40k particles.
// ────────────────────────────────────────────────────────────────────────────
class ParticleCloud {
  constructor(count, size, color, opacity = 0.85) {
    this.count = count;
    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.lifetimes = new Float32Array(count);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.material = new THREE.PointsMaterial({
      size, color, transparent: true, opacity,
      depthWrite: false,
      sizeAttenuation: true,
      blending: THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
  }

  // Seed particles in a box centred on (cx,cy,cz) with size (bx,by,bz)
  reseed(cx, cy, cz, bx, by, bz, rand) {
    for (let i = 0; i < this.count; i++) {
      this.positions[i*3]     = cx + (rand() - 0.5) * bx;
      this.positions[i*3 + 1] = cy + rand() * by;
      this.positions[i*3 + 2] = cz + (rand() - 0.5) * bz;
      this.lifetimes[i] = rand() * 5;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Snowfall — small bright flakes, slow fall, advected by wind
// ────────────────────────────────────────────────────────────────────────────
class SnowSystem {
  constructor() {
    this.cloud = new ParticleCloud(14000, 0.45, 0xf2f8ff, 0.9);
    this.cloud.points.name = 'snow';
    this.enabled = false;
    this.intensity = 0;
    this.box = { x: 300, y: 150, z: 300 };
  }
  get object3D() { return this.cloud.points; }
  setIntensity(v) {
    this.intensity = v;
    this.enabled = v > 0.02;
    this.cloud.points.visible = this.enabled;
    this.cloud.material.opacity = 0.5 + 0.45 * v;
  }
  reseedAround(cam, seed) {
    const rand = mulberry32((seed ^ 0x51ED01) | 0);
    this.cloud.reseed(cam.x, cam.y, cam.z, this.box.x, this.box.y, this.box.z, rand);
  }
  update(dt, cam, wind) {
    if (!this.enabled) return;
    const p = this.cloud.positions;
    const bx = this.box.x, by = this.box.y, bz = this.box.z;
    const halfX = bx / 2, halfZ = bz / 2;
    const w = new THREE.Vector3();
    for (let i = 0; i < this.cloud.count; i++) {
      const idx = i * 3;
      wind.sample(p[idx], p[idx+1], p[idx+2], w);
      // flakes fall ~0.8 m/s + drift by 70% of wind horizontal
      p[idx]   += (w.x * 0.7) * dt;
      p[idx+1] += (-0.8 + w.y * 0.3) * dt;
      p[idx+2] += (w.z * 0.7) * dt;
      // wrap within the box centred on camera
      const rx = p[idx] - cam.x, rz = p[idx+2] - cam.z, ry = p[idx+1] - cam.y;
      if (rx >  halfX) p[idx]   -= bx; else if (rx < -halfX) p[idx]   += bx;
      if (rz >  halfZ) p[idx+2] -= bz; else if (rz < -halfZ) p[idx+2] += bz;
      if (ry < -20)     p[idx+1] = cam.y + by * 0.9;
      else if (ry > by) p[idx+1] = cam.y - 10;
    }
    this.cloud.points.geometry.attributes.position.needsUpdate = true;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Sandy winds — low-altitude dust sheet that streaks horizontally
// ────────────────────────────────────────────────────────────────────────────
class SandSystem {
  constructor() {
    this.cloud = new ParticleCloud(10000, 0.35, 0xd7b480, 0.55);
    this.cloud.points.name = 'sand';
    this.enabled = false;
    this.intensity = 0;
    this.box = { x: 400, y: 50, z: 400 };
  }
  get object3D() { return this.cloud.points; }
  setIntensity(v) {
    this.intensity = v;
    this.enabled = v > 0.02;
    this.cloud.points.visible = this.enabled;
    this.cloud.material.opacity = 0.2 + 0.55 * v;
  }
  reseedAround(cam, seed) {
    const rand = mulberry32((seed ^ 0x5ADB0B) | 0);
    this.cloud.reseed(cam.x, Math.max(0, cam.y - 20), cam.z, this.box.x, this.box.y, this.box.z, rand);
  }
  update(dt, cam, wind) {
    if (!this.enabled) return;
    const p = this.cloud.positions;
    const bx = this.box.x, by = this.box.y, bz = this.box.z;
    const halfX = bx / 2, halfZ = bz / 2;
    const w = new THREE.Vector3();
    for (let i = 0; i < this.cloud.count; i++) {
      const idx = i * 3;
      wind.sample(p[idx], p[idx+1], p[idx+2], w);
      // dust rides the wind almost 1:1, minimal fall
      p[idx]   += (w.x * 1.1) * dt;
      p[idx+1] += (w.y * 0.5 - 0.05) * dt;   // tiny settle
      p[idx+2] += (w.z * 1.1) * dt;
      const rx = p[idx] - cam.x, rz = p[idx+2] - cam.z;
      if (rx >  halfX) p[idx]   -= bx; else if (rx < -halfX) p[idx]   += bx;
      if (rz >  halfZ) p[idx+2] -= bz; else if (rz < -halfZ) p[idx+2] += bz;
      if (p[idx+1] < Math.max(0, cam.y - 30)) p[idx+1] = cam.y + by - 5;
      if (p[idx+1] > cam.y + by)              p[idx+1] = Math.max(0, cam.y - 20);
    }
    this.cloud.points.geometry.attributes.position.needsUpdate = true;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Rain — longer streaks, fast fall
// ────────────────────────────────────────────────────────────────────────────
class RainSystem {
  constructor() {
    this.cloud = new ParticleCloud(7000, 0.22, 0x9fb4c8, 0.55);
    this.cloud.points.name = 'rain';
    this.enabled = false;
    this.box = { x: 200, y: 120, z: 200 };
  }
  get object3D() { return this.cloud.points; }
  setIntensity(v) {
    this.enabled = v > 0.02;
    this.cloud.points.visible = this.enabled;
    this.cloud.material.opacity = 0.3 + 0.5 * v;
  }
  reseedAround(cam, seed) {
    const rand = mulberry32((seed ^ 0x2A12B1) | 0);
    this.cloud.reseed(cam.x, cam.y, cam.z, this.box.x, this.box.y, this.box.z, rand);
  }
  update(dt, cam, wind) {
    if (!this.enabled) return;
    const p = this.cloud.positions;
    const bx = this.box.x, by = this.box.y, bz = this.box.z;
    const halfX = bx / 2, halfZ = bz / 2;
    const w = new THREE.Vector3();
    for (let i = 0; i < this.cloud.count; i++) {
      const idx = i * 3;
      wind.sample(p[idx], p[idx+1], p[idx+2], w);
      p[idx]   += (w.x * 0.4) * dt;
      p[idx+1] += (-9 + w.y * 0.2) * dt;
      p[idx+2] += (w.z * 0.4) * dt;
      const rx = p[idx] - cam.x, rz = p[idx+2] - cam.z, ry = p[idx+1] - cam.y;
      if (rx >  halfX) p[idx]   -= bx; else if (rx < -halfX) p[idx]   += bx;
      if (rz >  halfZ) p[idx+2] -= bz; else if (rz < -halfZ) p[idx+2] += bz;
      if (ry < -10)     p[idx+1] = cam.y + by * 0.9;
      else if (ry > by) p[idx+1] = cam.y - 5;
    }
    this.cloud.points.geometry.attributes.position.needsUpdate = true;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Top-level Weather aggregator
// ────────────────────────────────────────────────────────────────────────────
export class Weather {
  constructor(scene) {
    this.scene = scene;
    this.wind  = null;
    this.snow  = new SnowSystem();
    this.sand  = new SandSystem();
    this.rain  = new RainSystem();
    scene.add(this.snow.object3D);
    scene.add(this.sand.object3D);
    scene.add(this.rain.object3D);
    this.cfg = null;
  }
  apply(cfg, camPos) {
    this.cfg = cfg;
    if (!this.wind) this.wind = new WindField(cfg);
    else            this.wind.setConfig(cfg);
    this.snow.setIntensity(cfg.snow);
    this.sand.setIntensity(cfg.sand);
    this.rain.setIntensity(cfg.rain);
    this.snow.reseedAround(camPos, cfg.seed);
    this.sand.reseedAround(camPos, cfg.seed);
    this.rain.reseedAround(camPos, cfg.seed);
  }
  update(dt, camPos) {
    this.wind?.update(dt);
    this.snow.update(dt, camPos, this.wind);
    this.sand.update(dt, camPos, this.wind);
    this.rain.update(dt, camPos, this.wind);
  }
  sampleWind(x, y, z, out) { return this.wind.sample(x, y, z, out); }
}
