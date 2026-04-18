// trainer.js
// Autopilot + reinforcement-learning trainer.
//
// Two modes live here:
//   1. Autopilot — cascaded PID that actually flies the drone through waypoints.
//      Acts as both a working demo and the "expert" baseline reward for RL.
//   2. RL trainer — a small linear policy π(s) = W·s + b, optimised by the
//      Cross-Entropy Method. CEM is gradient-free, works well for small
//      action spaces like quadcopter body-rate control, and produces visible
//      improvement within a few hundred episodes of fast-sim rollouts.
//
// Fast-sim rollouts use the *same* Drone + WindField code as the live scene,
// just without rendering. That's the point of having a clean, deterministic
// physics layer.

import * as THREE from 'three';
import { Drone } from './drone.js';
import { WindField } from './weather.js';

// ────────────────────────────────────────────────────────────────────────────
// Waypoints
// ────────────────────────────────────────────────────────────────────────────
export class WaypointCourse {
  constructor(scene, heightAt, seed = 1) {
    this.scene = scene;
    this.heightAt = heightAt;
    this.points = [];
    this.index = 0;
    this.markers = new THREE.Group();
    scene.add(this.markers);
    this.generate(seed);
  }
  generate(seed) {
    this.dispose();
    let s = seed >>> 0;
    const rand = () => {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const N = 7;
    let angle = 0;
    const radius = 45;
    for (let i = 0; i < N; i++) {
      angle += (Math.PI * 2 / N) + (rand() - 0.5) * 0.5;
      const r = radius * (0.7 + rand() * 0.5);
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      const y = this.heightAt(x, z) + 18 + rand() * 18;
      this.points.push(new THREE.Vector3(x, y, z));
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(3.5, 0.25, 8, 24),
        new THREE.MeshStandardMaterial({
          color: 0xcccccc, emissive: 0x555555, emissiveIntensity: 1.2,
        }),
      );
      ring.position.set(x, y, z);
      ring.rotation.x = Math.PI / 2;
      ring.userData.index = i;
      this.markers.add(ring);
    }
    this.index = 0;
    this.updateMarkers();
  }
  dispose() {
    while (this.markers.children.length) {
      const c = this.markers.children[0];
      c.geometry?.dispose(); c.material?.dispose();
      this.markers.remove(c);
    }
    this.points = [];
    this.index = 0;
  }
  updateMarkers() {
    this.markers.children.forEach((m, i) => {
      const done = i < this.index;
      const cur  = i === this.index;
      m.material.emissiveIntensity = cur ? 1.5 : (done ? 0.1 : 0.6);
      m.material.color.set(cur ? 0xffffff : (done ? 0x444444 : 0x888888));
      m.scale.setScalar(cur ? 1.25 : 1.0);
    });
  }
  current() { return this.points[this.index] ?? null; }
  next()    { return this.points[this.index + 1] ?? this.points[this.index] ?? null; }
  checkReached(pos, radius = 4.5) {
    const tgt = this.current();
    if (!tgt) return false;
    if (pos.distanceTo(tgt) < radius) {
      this.index++;
      this.updateMarkers();
      return true;
    }
    return false;
  }
  done() { return this.index >= this.points.length; }
}

// ────────────────────────────────────────────────────────────────────────────
// PID Autopilot — cascaded position → velocity → body-rate
// ────────────────────────────────────────────────────────────────────────────
export class Autopilot {
  constructor() {
    this.prevErr = new THREE.Vector3();
    this.iErr = new THREE.Vector3();
  }
  reset() { this.prevErr.set(0, 0, 0); this.iErr.set(0, 0, 0); }

  // Returns { thrust, rateCmd } given state + target
  act(drone, target, dt) {
    if (!target) return { thrust: 0.5, rateCmd: new THREE.Vector3() };

    // desired velocity toward target (capped)
    const toTgt = new THREE.Vector3().subVectors(target, drone.pos);
    const dist = toTgt.length();
    const vMax = 14;
    const desiredV = toTgt.normalize().multiplyScalar(Math.min(vMax, dist * 1.2));

    const velErr = new THREE.Vector3().subVectors(desiredV, drone.vel);

    // horizontal → tilt command
    // approximate: pitch toward -Z-local, roll toward +X-local to accelerate
    // find body-frame horizontal error
    const invQ = drone.quat.clone().invert();
    const errLocal = velErr.clone().applyQuaternion(invQ);

    const tiltGain = 0.12;
    const targetPitch = -THREE.MathUtils.clamp(errLocal.z * tiltGain, -0.5, 0.5);
    const targetRoll  =  THREE.MathUtils.clamp(errLocal.x * tiltGain, -0.5, 0.5);

    // attitude error — derive current pitch/roll
    const euler = new THREE.Euler().setFromQuaternion(drone.quat, 'YXZ');
    const pitch = euler.x;
    const roll = euler.z;

    const kP = 4.0;
    const pCmd = (targetPitch - pitch) * kP - drone.omega.x * 0.8;
    const rCmd = (targetRoll  - roll)  * kP - drone.omega.z * 0.8;

    // yaw: aim at target
    const flatTo = new THREE.Vector3(toTgt.x, 0, toTgt.z).normalize();
    const desiredYaw = Math.atan2(flatTo.x, flatTo.z);
    let yawErr = desiredYaw - euler.y;
    while (yawErr >  Math.PI) yawErr -= Math.PI * 2;
    while (yawErr < -Math.PI) yawErr += Math.PI * 2;
    const yCmd = THREE.MathUtils.clamp(yawErr * 1.2, -1.5, 1.5);

    // thrust to manage altitude + feed-forward for tilt loss
    const altErr = target.y - drone.pos.y;
    const vY = drone.vel.y;
    const hoverThrust = 0.5;               // approx normalised
    const tiltCos = Math.max(0.3, Math.cos(pitch) * Math.cos(roll));
    let T = hoverThrust / tiltCos
          + THREE.MathUtils.clamp(altErr * 0.04 - vY * 0.08, -0.3, 0.45);
    T = THREE.MathUtils.clamp(T, 0.0, 1.0);

    return {
      thrust: T,
      rateCmd: new THREE.Vector3(pCmd, yCmd, rCmd),
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Minimal linear policy: a = W·s + b (tanh on rate components, sigmoid on T)
// ────────────────────────────────────────────────────────────────────────────
const OBS_DIM = 14;   // see buildObs
const ACT_DIM = 4;    // [thrust, pitch_rate, roll_rate, yaw_rate]
const PARAM_DIM = ACT_DIM * (OBS_DIM + 1);

function buildObs(drone, target, env) {
  if (!target) target = drone.pos;
  const rel = new THREE.Vector3().subVectors(target, drone.pos);
  const invQ = drone.quat.clone().invert();
  const relBody = rel.clone().applyQuaternion(invQ);
  const velBody = drone.vel.clone().applyQuaternion(invQ);
  const windBody = env.wind.clone().applyQuaternion(invQ);
  const eul = new THREE.Euler().setFromQuaternion(drone.quat, 'YXZ');
  return [
    relBody.x / 50, relBody.y / 50, relBody.z / 50,
    velBody.x / 10, velBody.y / 10, velBody.z / 10,
    eul.x, eul.z,
    drone.omega.x, drone.omega.y, drone.omega.z,
    windBody.x / 10, windBody.z / 10,
    (env.ambientC - 20) / 40,
  ];
}

function linearPolicy(params, obs) {
  // params shape: [ACT_DIM][OBS_DIM+1]  flattened
  const out = new Array(ACT_DIM);
  for (let a = 0; a < ACT_DIM; a++) {
    let s = params[a * (OBS_DIM + 1) + OBS_DIM]; // bias
    for (let i = 0; i < OBS_DIM; i++) {
      s += params[a * (OBS_DIM + 1) + i] * obs[i];
    }
    out[a] = s;
  }
  return {
    thrust: sigmoid(out[0]),
    rateCmd: new THREE.Vector3(
      Math.tanh(out[1]) * 3,
      Math.tanh(out[3]) * 2,
      Math.tanh(out[2]) * 3,
    ),
  };
}
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

// ────────────────────────────────────────────────────────────────────────────
// Fast headless rollout — no rendering, used by CEM
// ────────────────────────────────────────────────────────────────────────────
function rollout(cfg, params, course, startPos, steps = 1500, dt = 1 / 60) {
  const drone = new Drone(null, { headless: true });
  drone.reset(startPos);
  const wind = new WindField(cfg);

  let localIndex = 0;
  const targets = course.points.slice();

  let reward = 0;
  let prevDist = startPos.distanceTo(targets[0] ?? startPos);
  const env = { ambientC: cfg.ambientC, wind: new THREE.Vector3(), dustLevel: cfg.sand, rainLevel: cfg.rain, snowLevel: cfg.snow, heightAt: () => -1e6 };

  for (let t = 0; t < steps; t++) {
    const tgt = targets[localIndex] ?? targets[targets.length - 1];
    wind.update(dt);
    wind.sample(drone.pos.x, drone.pos.y, drone.pos.z, env.wind);
    const obs = buildObs(drone, tgt, env);
    const inputs = linearPolicy(params, obs);
    drone.step(dt, inputs, env);

    if (drone.crashed) { reward -= 80; break; }

    const d = drone.pos.distanceTo(tgt);
    reward += (prevDist - d) * 0.5;   // shaped by progress
    reward -= inputs.thrust * inputs.thrust * 0.02;
    prevDist = d;

    if (d < 4.5) {
      reward += 50;
      localIndex++;
      if (localIndex >= targets.length) break;
      prevDist = drone.pos.distanceTo(targets[localIndex]);
    }

    // out-of-bounds
    if (drone.pos.y > 500 || Math.abs(drone.pos.x) > 450 || Math.abs(drone.pos.z) > 450) {
      reward -= 50; break;
    }
  }

  reward += localIndex * 10;   // progress bonus
  return reward;
}

// ────────────────────────────────────────────────────────────────────────────
// Cross-Entropy Method trainer
// ────────────────────────────────────────────────────────────────────────────
export class RLTrainer {
  constructor() {
    this.mu = new Float64Array(PARAM_DIM);
    this.sigma = new Float64Array(PARAM_DIM).fill(0.5);
    this.bestParams = new Float64Array(PARAM_DIM);
    this.bestReward = -Infinity;
    this.episode = 0;
    this.history = [];    // mean reward per iteration
    this.popSize = 24;
    this.eliteFrac = 0.25;
  }

  sampleParams() {
    const p = new Float64Array(PARAM_DIM);
    for (let i = 0; i < PARAM_DIM; i++) {
      // Box-Muller
      const u1 = Math.random() || 1e-9, u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      p[i] = this.mu[i] + this.sigma[i] * z;
    }
    return p;
  }

  // Run one CEM iteration (popSize rollouts) — meant to be called from a button.
  // Returns { iteration, meanReward, bestReward }.
  iterate(cfg, course, startPos, steps = 1500) {
    const pop = [];
    let sumR = 0;
    for (let i = 0; i < this.popSize; i++) {
      const params = this.sampleParams();
      const r = rollout(cfg, params, course, startPos, steps);
      pop.push({ params, r });
      sumR += r;
      this.episode++;
    }
    pop.sort((a, b) => b.r - a.r);
    const nElite = Math.max(2, Math.floor(this.popSize * this.eliteFrac));
    const elite = pop.slice(0, nElite);

    // refit mu and sigma
    for (let i = 0; i < PARAM_DIM; i++) {
      let m = 0;
      for (const e of elite) m += e.params[i];
      m /= nElite;
      let v = 0;
      for (const e of elite) { const d = e.params[i] - m; v += d * d; }
      v = Math.sqrt(v / nElite) + 0.05; // keep some exploration
      this.mu[i] = m;
      this.sigma[i] = v;
    }

    if (pop[0].r > this.bestReward) {
      this.bestReward = pop[0].r;
      this.bestParams.set(pop[0].params);
    }
    const mean = sumR / this.popSize;
    this.history.push(mean);
    if (this.history.length > 120) this.history.shift();
    return { iteration: this.history.length, meanReward: mean, bestReward: this.bestReward };
  }

  // Use current mean policy for live inference
  act(drone, target, env) {
    const obs = buildObs(drone, target, env);
    return linearPolicy(this.bestReward > -Infinity ? this.bestParams : this.mu, obs);
  }
}
