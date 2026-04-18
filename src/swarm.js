// swarm.js
// Adversarial drone swarm with evolutionary intercept training.
//
// Two swarms coexist:
//   1. FRIENDLY (defender) swarm — white/green drones that train over many
//      generations to intercept the adversarial (red) drones. Each generation
//      the bottom performers are reseeded from elite, so the swarm visibly
//      improves at targeting and intercepting enemies.
//   2. ADVERSARIAL (enemy) swarm — red drones that fly evasive patterns.
//      They respawn when intercepted, maintaining pressure on the defenders.
//
// The intercept mechanic: when a friendly drone gets within capture radius
// of an enemy drone, the enemy is "neutralized" (respawned elsewhere) and
// the friendly drone's reward/skill increases. Over generations, defenders
// learn tighter pursuit patterns with less wasted motion.

import * as THREE from 'three';

// ────────────────────────────────────────────────────────────────────────────
// Drone-shaped geometry, manually merged from primitives (no addons).
// ────────────────────────────────────────────────────────────────────────────
function makeDroneGeometry() {
  function makeBox(sx, sy, sz, tx, ty, tz, ry = 0) {
    const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
    if (ry) g.rotateY(ry);
    g.translate(tx, ty, tz);
    return g;
  }
  function makeCyl(r, h, tx, ty, tz) {
    const g = new THREE.CylinderGeometry(r, r, h, 10).toNonIndexed();
    g.translate(tx, ty, tz);
    return g;
  }

  const parts = [
    makeBox(0.30, 0.10, 0.30, 0, 0, 0),                  // pod
    makeBox(0.55, 0.025, 0.04, 0, 0, 0,  Math.PI / 4),   // arm 1
    makeBox(0.55, 0.025, 0.04, 0, 0, 0, -Math.PI / 4),   // arm 2
    makeCyl(0.045, 0.05,  0.20, 0.05,  0.20),            // motor FR
    makeCyl(0.045, 0.05, -0.20, 0.05,  0.20),            // motor FL
    makeCyl(0.045, 0.05, -0.20, 0.05, -0.20),            // motor BL
    makeCyl(0.045, 0.05,  0.20, 0.05, -0.20),            // motor BR
    makeCyl(0.13,  0.005, 0.20, 0.09,  0.20),            // prop FR
    makeCyl(0.13,  0.005,-0.20, 0.09,  0.20),            // prop FL
    makeCyl(0.13,  0.005,-0.20, 0.09, -0.20),            // prop BL
    makeCyl(0.13,  0.005, 0.20, 0.09, -0.20),            // prop BR
    makeBox(0.05, 0.04, 0.10, 0, 0.02, 0.18),            // nose marker
  ];

  let total = 0;
  for (const p of parts) total += p.attributes.position.count;

  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  let off = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array, off * 3);
    nrm.set(p.attributes.normal.array,   off * 3);
    off += p.attributes.position.count;
    p.dispose();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(nrm, 3));
  geo.computeBoundingSphere();
  return geo;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ────────────────────────────────────────────────────────────────────────────
// Intercept line renderer — shows pursuit lines from defenders to targets
// ────────────────────────────────────────────────────────────────────────────
class InterceptLines {
  constructor(scene, maxLines) {
    this.maxLines = maxLines;
    const positions = new Float32Array(maxLines * 2 * 3);
    const colors    = new Float32Array(maxLines * 2 * 3);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.3, depthWrite: false,
    });
    this.lines = new THREE.LineSegments(this.geo, this.mat);
    this.lines.frustumCulled = false;
    scene.add(this.lines);
  }
  update(defenders, enemies) {
    const pos = this.geo.attributes.position.array;
    const col = this.geo.attributes.color.array;
    let count = 0;
    for (let i = 0; i < defenders.length && count < this.maxLines; i++) {
      const d = defenders[i];
      if (d.targetEnemy < 0 || d.targetEnemy >= enemies.length) continue;
      const e = enemies[d.targetEnemy];
      const dist = d.pos.distanceTo(e.pos);
      if (dist > 50) continue; // only show close pursuit lines
      const idx = count * 6;
      pos[idx]     = d.pos.x; pos[idx+1] = d.pos.y; pos[idx+2] = d.pos.z;
      pos[idx+3]   = e.pos.x; pos[idx+4] = e.pos.y; pos[idx+5] = e.pos.z;
      // color: green at defender end, fading to dark at enemy end
      const intensity = clamp(1 - dist / 50, 0, 1) * d.skill;
      col[idx]   = 0.2; col[idx+1] = 0.9 * intensity; col[idx+2] = 0.2;
      col[idx+3] = 0.4; col[idx+4] = 0.1;             col[idx+5] = 0.1;
      count++;
    }
    this.geo.setDrawRange(0, count * 2);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
  dispose() {
    this.lines.parent?.remove(this.lines);
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Swarm — now contains both friendly (defender) and adversarial (enemy) drones
// ────────────────────────────────────────────────────────────────────────────
export class Swarm {
  constructor(scene, { count = 80 } = {}) {
    this.scene = scene;
    this.N = count;                   // friendly/defender count
    this.enemyCount = 25;             // adversarial count
    this.INTERCEPT_RADIUS = 3.5;      // capture distance

    const geo = makeDroneGeometry();

    // ── Defender mesh (friendly swarm) ──
    const defMat = new THREE.MeshStandardMaterial({
      roughness: 0.55, metalness: 0.25, emissive: 0x000000,
    });
    this.mesh = new THREE.InstancedMesh(geo, defMat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    const initCol = new THREE.Color(0xffffff);
    for (let i = 0; i < count; i++) this.mesh.setColorAt(i, initCol);
    if (this.mesh.instanceColor) this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);

    // ── Enemy mesh (adversarial swarm) ──
    const enemyGeo = makeDroneGeometry();
    const enemyMat = new THREE.MeshStandardMaterial({
      roughness: 0.4, metalness: 0.3,
      emissive: 0x330000, emissiveIntensity: 0.8,
    });
    this.enemyMesh = new THREE.InstancedMesh(enemyGeo, enemyMat, this.enemyCount);
    this.enemyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.enemyMesh.frustumCulled = false;
    this.enemyMesh.castShadow = false;
    const redCol = new THREE.Color(0xff2222);
    for (let i = 0; i < this.enemyCount; i++) this.enemyMesh.setColorAt(i, redCol);
    if (this.enemyMesh.instanceColor) this.enemyMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.enemyMesh);

    // ── Intercept lines ──
    this.interceptLines = new InterceptLines(scene, count);

    // ── Per-agent state: defenders ──
    this.agents = new Array(count);
    for (let i = 0; i < count; i++) {
      this.agents[i] = {
        pos:          new THREE.Vector3(),
        vel:          new THREE.Vector3(),
        target:       new THREE.Vector3(),
        quat:         new THREE.Quaternion(),
        skill:        Math.random() * 0.35,
        interceptsDone: 0,
        targetEnemy:  -1,               // index of assigned enemy
        // pursuit parameters — unique noise signature per drone
        noisePhase:   Math.random() * Math.PI * 2,
        noiseFreq:    0.5 + Math.random() * 1.5,
        bornAt:       -Math.random() * 5,
        // tracking: how well this drone pursued (for evolution)
        genReward:    0,
        closestApproach: Infinity,
      };
    }

    // ── Per-agent state: enemies ──
    this.enemies = new Array(this.enemyCount);
    for (let i = 0; i < this.enemyCount; i++) {
      this.enemies[i] = {
        pos:        new THREE.Vector3(),
        vel:        new THREE.Vector3(),
        quat:       new THREE.Quaternion(),
        evasion:    0.3 + Math.random() * 0.4,  // how aggressively they evade
        noisePhase: Math.random() * Math.PI * 2,
        noiseFreq:  0.6 + Math.random() * 1.2,
        waypoint:   new THREE.Vector3(),         // current patrol target
        alive:      true,
        respawnTimer: 0,
      };
    }

    this.cfg = null;
    this.course = null;
    this.heightAt = (x, z) => 0;
    this.spawnPos = new THREE.Vector3(0, 30, 0);

    // Training cadence
    this.simTime = 0;
    this.generation = 1;
    this.genTimer = 0;
    this.genLength = 20;               // faster gens for visible evolution
    this.totalReseeds = 0;
    this.totalIntercepts = 0;
    this.genIntercepts = 0;

    // Fabricated stats published to the HUD
    this.stats = {
      meanReward: 0,
      bestReward: 0,
      lifetimeWaypoints: 0,          // repurposed as lifetime intercepts
      alive: count,
      crashed: 0,
    };

    // Scratch
    this._m = new THREE.Matrix4();
    this._s = new THREE.Vector3(1, 1, 1);
    this._enemyScale = new THREE.Vector3(0.8, 0.8, 0.8); // enemies slightly smaller
    this._tint = new THREE.Color();
    this._fwd = new THREE.Vector3();
    this._upZ = new THREE.Vector3(0, 0, 1);
    this._wind = new THREE.Vector3();
    this._diff = new THREE.Vector3();
  }

  init(cfg, course, heightAt) {
    this.cfg = cfg;
    this.course = course;
    this.heightAt = heightAt;

    const baseY = heightAt(0, 0) + (cfg.startAltitude ?? 25);
    this.spawnPos.set(0, baseY, 0);

    this.simTime = 0;
    this.generation = 1;
    this.genTimer = 0;
    this.totalReseeds = 0;
    this.totalIntercepts = 0;
    this.genIntercepts = 0;
    this.stats.lifetimeWaypoints = 0;
    this.stats.bestReward = 0;
    this.stats.meanReward = 0;

    // ── Spawn defenders on one side ──
    for (let i = 0; i < this.N; i++) {
      const a = this.agents[i];
      const ang = (i / this.N) * Math.PI * 2 + Math.random() * 0.4;
      const r   = 10 + Math.random() * 30;
      a.pos.set(
        Math.cos(ang) * r - 20,
        baseY + (Math.random() - 0.5) * 12,
        Math.sin(ang) * r,
      );
      const ground = heightAt(a.pos.x, a.pos.z);
      a.pos.y = Math.max(a.pos.y, ground + 8);
      a.vel.set(
        (Math.random() - 0.5) * 3,
        (Math.random() - 0.5) * 1,
        (Math.random() - 0.5) * 3,
      );
      a.skill = 0.04 + Math.random() * 0.25;
      a.interceptsDone = 0;
      a.targetEnemy = -1;
      a.noisePhase = Math.random() * Math.PI * 2;
      a.noiseFreq  = 0.5 + Math.random() * 1.5;
      a.bornAt = -Math.random() * 5;
      a.genReward = 0;
      a.closestApproach = Infinity;
    }

    // ── Spawn enemies on opposite side ──
    for (let i = 0; i < this.enemyCount; i++) {
      this._spawnEnemy(i, baseY);
    }

    // Assign initial targets
    this._assignTargets();
  }

  _spawnEnemy(i, baseY) {
    const e = this.enemies[i];
    baseY = baseY ?? this.spawnPos.y;
    const ang = (i / this.enemyCount) * Math.PI * 2 + Math.random() * 0.6;
    const r   = 30 + Math.random() * 50;
    e.pos.set(
      Math.cos(ang) * r + 25,
      baseY + (Math.random() - 0.5) * 15,
      Math.sin(ang) * r,
    );
    const ground = this.heightAt(e.pos.x, e.pos.z);
    e.pos.y = Math.max(e.pos.y, ground + 8);
    e.vel.set(
      (Math.random() - 0.5) * 6,
      (Math.random() - 0.5) * 2,
      (Math.random() - 0.5) * 6,
    );
    e.alive = true;
    e.respawnTimer = 0;
    e.evasion = 0.3 + Math.random() * 0.4;
    this._pickEnemyWaypoint(e);
  }

  _pickEnemyWaypoint(e) {
    const ang = Math.random() * Math.PI * 2;
    const r   = 20 + Math.random() * 60;
    e.waypoint.set(
      Math.cos(ang) * r,
      this.spawnPos.y + (Math.random() - 0.5) * 20,
      Math.sin(ang) * r,
    );
    const ground = this.heightAt(e.waypoint.x, e.waypoint.z);
    if (e.waypoint.y < ground + 8) e.waypoint.y = ground + 8;
  }

  // Assign each defender to the nearest unassigned (or least-assigned) enemy
  _assignTargets() {
    // Count how many defenders target each enemy
    const assignCounts = new Array(this.enemyCount).fill(0);

    for (let i = 0; i < this.N; i++) {
      const a = this.agents[i];
      // Find nearest alive enemy, preferring ones with fewer assigned pursuers
      let bestIdx = 0, bestScore = Infinity;
      for (let j = 0; j < this.enemyCount; j++) {
        if (!this.enemies[j].alive) continue;
        const dist = a.pos.distanceTo(this.enemies[j].pos);
        const crowdPenalty = assignCounts[j] * 15;
        const score = dist + crowdPenalty;
        if (score < bestScore) { bestScore = score; bestIdx = j; }
      }
      a.targetEnemy = bestIdx;
      assignCounts[bestIdx]++;
    }
  }

  step(dt, windField, envBase) {
    this.simTime += dt;
    this.genTimer += dt;

    // Reassign targets periodically (every ~2s) so defenders redistribute
    if (Math.floor(this.simTime * 0.5) !== Math.floor((this.simTime - dt) * 0.5)) {
      this._assignTargets();
    }

    // ── Step enemy (adversarial) drones ──
    this._stepEnemies(dt, windField);

    // ── Step friendly (defender) drones ──
    let sumSkill = 0, maxSk = 0, minSk = 1;

    for (let i = 0; i < this.N; i++) {
      const a = this.agents[i];

      // Get assigned enemy position as target
      const enemyIdx = clamp(a.targetEnemy, 0, this.enemyCount - 1);
      const enemy = this.enemies[enemyIdx];

      if (enemy.alive) {
        // ── Pursuit steering ──
        // High-skill drones use lead pursuit (predict enemy motion)
        // Low-skill drones just point at current enemy position
        const leadTime = a.skill * 0.8; // seconds of prediction
        a.target.copy(enemy.pos).addScaledVector(enemy.vel, leadTime);

        // Add skill-dependent scatter (inaccuracy)
        const scatter = (1 - a.skill) * 14 + 1.5;
        a.target.x += (Math.random() - 0.5) * scatter * dt * 10;
        a.target.y += (Math.random() - 0.5) * scatter * 0.3 * dt * 10;
        a.target.z += (Math.random() - 0.5) * scatter * dt * 10;
      }

      const toTgt = this._diff.copy(a.target).sub(a.pos);
      const dist = toTgt.length();

      // ── Check intercept ──
      if (enemy.alive && a.pos.distanceTo(enemy.pos) < this.INTERCEPT_RADIUS) {
        a.interceptsDone++;
        a.genReward += 10;
        this.totalIntercepts++;
        this.genIntercepts++;
        this.stats.lifetimeWaypoints++;
        // Respawn enemy elsewhere
        this._spawnEnemy(enemyIdx);
        this._assignTargets();
      }

      // Track closest approach for reward shaping
      if (enemy.alive) {
        const d = a.pos.distanceTo(enemy.pos);
        if (d < a.closestApproach) a.closestApproach = d;
        // Reward for closing distance
        a.genReward += Math.max(0, 30 - d) * 0.001 * dt;
      }

      // Steering force toward target
      const vMax = 6 + a.skill * 18;
      const desiredV = toTgt.normalize().multiplyScalar(Math.min(vMax, dist * 1.1));
      const steer = desiredV.sub(a.vel);
      const steerStrength = 1.0 + a.skill * 2.5;

      // Brownian noise — shrinks with skill (precision improves)
      a.noisePhase += dt * a.noiseFreq;
      const noiseAmp = (1 - a.skill) * 7 + 0.8;
      const nx = Math.sin(a.noisePhase * 1.7 + i * 0.71) * noiseAmp;
      const ny = Math.cos(a.noisePhase * 1.3 + i * 1.13) * noiseAmp * 0.3;
      const nz = Math.sin(a.noisePhase * 2.1 + i * 0.53) * noiseAmp;

      a.vel.x += (steer.x * steerStrength + nx) * dt;
      a.vel.y += (steer.y * steerStrength + ny) * dt;
      a.vel.z += (steer.z * steerStrength + nz) * dt;

      // Wind drift
      if (windField) {
        windField.sample(a.pos.x, a.pos.y, a.pos.z, this._wind);
        a.vel.addScaledVector(this._wind, dt * 0.06);
      }

      // Damping
      const damp = Math.pow(0.92, dt * 60);
      a.vel.multiplyScalar(damp);

      // Speed clamp
      const speed = a.vel.length();
      const speedMax = 30;
      if (speed > speedMax) a.vel.multiplyScalar(speedMax / speed);

      // Integrate
      a.pos.addScaledVector(a.vel, dt);

      // Floor
      const ground = this.heightAt(a.pos.x, a.pos.z);
      const floorY = ground + 3;
      if (a.pos.y < floorY) {
        a.pos.y = floorY;
        if (a.vel.y < 0) a.vel.y = -a.vel.y * 0.3;
      }

      // Soft bounds
      const B = 100;
      if (Math.abs(a.pos.x) > B || Math.abs(a.pos.z) > B || a.pos.y > 100) {
        a.vel.multiplyScalar(0.5);
        a.pos.x = clamp(a.pos.x, -B, B);
        a.pos.z = clamp(a.pos.z, -B, B);
        a.pos.y = Math.min(a.pos.y, 100);
      }

      // Skill drifts upward very slowly (main improvement is from evolution)
      a.skill = clamp(a.skill + dt * 0.001, 0, 1);

      sumSkill += a.skill;
      if (a.skill > maxSk) maxSk = a.skill;
      if (a.skill < minSk) minSk = a.skill;

      // Orient toward velocity
      const sp = a.vel.length();
      if (sp > 0.4) {
        this._fwd.copy(a.vel).divideScalar(sp);
        a.quat.setFromUnitVectors(this._upZ, this._fwd);
      }

      this._m.compose(a.pos, a.quat, this._s);
      this.mesh.setMatrixAt(i, this._m);

      // Color: evolves from dim grey (skill 0) → bright white/green (skill 1)
      // Shows training progress visually
      const g = 0.3 + a.skill * 0.7;
      this._tint.setRGB(g * 0.7, g, g * 0.7);
      this.mesh.setColorAt(i, this._tint);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    // Update intercept lines
    this.interceptLines.update(this.agents, this.enemies);

    // Cache aggregates for HUD
    this._meanSkill = sumSkill / this.N;
    this._maxSkill = maxSk;
    this._minSkill = minSk;

    // ── Fabricated mean reward shaped by intercept rate ──
    const ambient = this.cfg?.ambientC ?? 20;
    const tempPenalty = Math.max(0, -ambient) * 0.15 + Math.max(0, ambient - 35) * 0.4;
    const wp = this.cfg?.wind ?? 0;
    const windPenalty = Math.max(0, wp - 8) * 0.6;
    const t = this.simTime;
    const base = 8 + 130 * (1 - Math.exp(-t / 60));
    const interceptBonus = this.totalIntercepts * 0.4;
    const wave = Math.sin(t * 0.55) * 3 + Math.sin(t * 1.7 + 1.3) * 1.4;
    const jitter = (Math.random() - 0.5) * 5.5;
    this.stats.meanReward = base + wave + jitter + interceptBonus - tempPenalty - windPenalty;
    const bestNow = base * 1.35 + 12 + interceptBonus + (Math.random() - 0.5) * 6;
    if (bestNow > this.stats.bestReward) this.stats.bestReward = bestNow;

    if (this.genTimer >= this.genLength) {
      this.evolve();
      this.generation++;
      this.genTimer = 0;
      this.genIntercepts = 0;
      // Reset per-gen tracking
      for (const a of this.agents) {
        a.genReward = 0;
        a.closestApproach = Infinity;
      }
    }
  }

  _stepEnemies(dt, windField) {
    for (let i = 0; i < this.enemyCount; i++) {
      const e = this.enemies[i];
      if (!e.alive) {
        e.respawnTimer -= dt;
        if (e.respawnTimer <= 0) {
          this._spawnEnemy(i);
        }
        // hide off-screen
        this._m.compose(
          new THREE.Vector3(0, -1000, 0),
          e.quat, this._enemyScale,
        );
        this.enemyMesh.setMatrixAt(i, this._m);
        continue;
      }

      // Move toward patrol waypoint
      const toWp = this._diff.copy(e.waypoint).sub(e.pos);
      const dist = toWp.length();
      if (dist < 5) this._pickEnemyWaypoint(e);

      const evasionSpeed = 4 + e.evasion * 10;
      const desired = toWp.normalize().multiplyScalar(Math.min(evasionSpeed, dist * 0.8));
      const steer = desired.sub(e.vel);

      // Evasion: detect nearest pursuing defender and dodge away
      let closestDefDist = Infinity;
      let closestDefIdx = -1;
      for (let d = 0; d < this.N; d++) {
        if (this.agents[d].targetEnemy !== i) continue;
        const dd = this.agents[d].pos.distanceTo(e.pos);
        if (dd < closestDefDist) { closestDefDist = dd; closestDefIdx = d; }
      }

      // If a defender is close, add evasion force
      let evadeX = 0, evadeY = 0, evadeZ = 0;
      if (closestDefIdx >= 0 && closestDefDist < 25) {
        const flee = e.pos.clone().sub(this.agents[closestDefIdx].pos).normalize();
        const urgency = (25 - closestDefDist) / 25 * e.evasion * 12;
        evadeX = flee.x * urgency;
        evadeY = flee.y * urgency * 0.5;
        evadeZ = flee.z * urgency;
      }

      // Enemy noise — erratic movement
      e.noisePhase += dt * e.noiseFreq;
      const noiseAmp = 5 + e.evasion * 6;
      const nx = Math.sin(e.noisePhase * 2.1 + i * 1.3) * noiseAmp;
      const ny = Math.cos(e.noisePhase * 1.5 + i * 0.9) * noiseAmp * 0.3;
      const nz = Math.sin(e.noisePhase * 1.8 + i * 1.7) * noiseAmp;

      e.vel.x += (steer.x * 1.5 + nx + evadeX) * dt;
      e.vel.y += (steer.y * 1.5 + ny + evadeY) * dt;
      e.vel.z += (steer.z * 1.5 + nz + evadeZ) * dt;

      // Wind
      if (windField) {
        windField.sample(e.pos.x, e.pos.y, e.pos.z, this._wind);
        e.vel.addScaledVector(this._wind, dt * 0.05);
      }

      // Damping + speed limit
      e.vel.multiplyScalar(Math.pow(0.91, dt * 60));
      const speed = e.vel.length();
      if (speed > 22) e.vel.multiplyScalar(22 / speed);

      e.pos.addScaledVector(e.vel, dt);

      // Floor
      const ground = this.heightAt(e.pos.x, e.pos.z);
      if (e.pos.y < ground + 3) {
        e.pos.y = ground + 3;
        if (e.vel.y < 0) e.vel.y = -e.vel.y * 0.3;
      }

      // Soft bounds
      const B = 95;
      if (Math.abs(e.pos.x) > B || Math.abs(e.pos.z) > B || e.pos.y > 90) {
        e.vel.multiplyScalar(0.5);
        e.pos.x = clamp(e.pos.x, -B, B);
        e.pos.z = clamp(e.pos.z, -B, B);
        e.pos.y = Math.min(e.pos.y, 90);
        this._pickEnemyWaypoint(e);
      }

      // Orient
      const sp = e.vel.length();
      if (sp > 0.3) {
        this._fwd.copy(e.vel).divideScalar(sp);
        e.quat.setFromUnitVectors(this._upZ, this._fwd);
      }

      this._m.compose(e.pos, e.quat, this._enemyScale);
      this.enemyMesh.setMatrixAt(i, this._m);

      // Pulsing red color
      const pulse = 0.7 + Math.sin(this.simTime * 3 + i) * 0.3;
      this._tint.setRGB(pulse, 0.08, 0.05);
      this.enemyMesh.setColorAt(i, this._tint);
    }

    this.enemyMesh.instanceMatrix.needsUpdate = true;
    if (this.enemyMesh.instanceColor) this.enemyMesh.instanceColor.needsUpdate = true;
  }

  // Evolution: rank defenders by gen performance, reseed bottom half from elite
  evolve() {
    // Score each agent by intercepts + proximity reward
    const scored = this.agents.map((a, i) => ({
      idx: i,
      score: a.genReward + a.interceptsDone * 5 - a.closestApproach * 0.1,
    }));
    scored.sort((a, b) => b.score - a.score);

    const eliteCount = Math.floor(this.N * 0.3);
    const bottomStart = Math.floor(this.N * 0.5);

    // Bottom 50% get reseeded as mutated copies of random elite
    for (let k = bottomStart; k < this.N; k++) {
      const loser = this.agents[scored[k].idx];
      const eliteIdx = scored[Math.floor(Math.random() * eliteCount)].idx;
      const elite = this.agents[eliteIdx];
      loser.skill = clamp(elite.skill + (Math.random() - 0.3) * 0.08, 0.02, 1);
      this.totalReseeds++;
    }

    // Elite get a small upward skill boost
    for (let k = 0; k < eliteCount; k++) {
      const winner = this.agents[scored[k].idx];
      winner.skill = clamp(winner.skill + 0.025 + Math.random() * 0.015, 0, 1);
    }

    // Middle tier gets modest improvement
    for (let k = eliteCount; k < bottomStart; k++) {
      const mid = this.agents[scored[k].idx];
      mid.skill = clamp(mid.skill + 0.01 + Math.random() * 0.01, 0, 1);
    }

    // Make enemies slightly harder each generation
    for (const e of this.enemies) {
      e.evasion = clamp(e.evasion + 0.02, 0, 0.85);
    }
  }

  bestAliveIndex() {
    let best = 0, bs = -Infinity;
    for (let i = 0; i < this.N; i++) {
      if (this.agents[i].skill > bs) { bs = this.agents[i].skill; best = i; }
    }
    return best;
  }

  bestAliveDrone() {
    return this.agents[this.bestAliveIndex()];
  }

  aggregate() {
    const ambient = this.cfg?.ambientC ?? 20;
    const tCold = Math.max(0, 5 - ambient) / 35;
    const meanBatt = clamp(0.92 - this.simTime * 0.0028 - tCold * 0.20, 0.05, 1);
    const meanMotorT = ambient + 35 + (this._meanSkill ?? 0) * 55
                     + Math.sin(this.simTime * 0.4) * 4;

    // Count alive enemies
    let enemiesAlive = 0;
    for (const e of this.enemies) if (e.alive) enemiesAlive++;

    return {
      generation: this.generation,
      genProgress: clamp(this.genTimer / this.genLength, 0, 1),
      total: this.N,
      alive: this.N,
      crashed: 0,
      meanSkill: this._meanSkill ?? 0,
      maxSkill: this._maxSkill ?? 0,
      minSkill: this._minSkill ?? 0,
      meanBattery: meanBatt,
      minBattery: clamp(meanBatt - 0.18, 0.02, 1),
      meanMotorT,
      bestReward: this.stats.bestReward,
      meanReward: this.stats.meanReward,
      lifetimeWaypoints: this.stats.lifetimeWaypoints,
      meanWaypointsThisGen: this.genIntercepts,
      totalReseeds: this.totalReseeds,
      // New adversarial stats
      enemyCount: this.enemyCount,
      enemiesAlive,
      totalIntercepts: this.totalIntercepts,
      genIntercepts: this.genIntercepts,
    };
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.scene.remove(this.enemyMesh);
    this.enemyMesh.geometry.dispose();
    this.enemyMesh.material.dispose();
    this.interceptLines.dispose();
  }
}
