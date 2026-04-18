// drone.js
// Quadcopter rigid-body + electronics + thermal model.
//
// Physics: 6-DOF rigid body, body-rate command surface
//   inputs  = [T_norm, p_cmd, q_cmd, r_cmd]    (thrust 0..1, body rates rad/s)
//   outputs = state (pos, vel, q, ω) + telemetry
//
// Electronics model is intentionally lightweight but captures the effects the
// user asked about: snow/freezing air increases battery internal resistance
// and reduces effective capacity; sandy winds increase IMU/GPS noise and sand
// erodes prop efficiency; extreme ambient temperatures thermally throttle
// motors & ESCs; CPU heats under load.

import * as THREE from 'three';

const GRAVITY = 9.81;

// ────────────────────────────────────────────────────────────────────────────
// Build the visible drone mesh (X-frame quad)
// ────────────────────────────────────────────────────────────────────────────
function buildMesh() {
  const group = new THREE.Group();
  group.name = 'drone';

  // central pod
  const pod = new THREE.Mesh(
    new THREE.BoxGeometry(0.28, 0.10, 0.28),
    new THREE.MeshStandardMaterial({ color: 0x1e2430, roughness: 0.6, metalness: 0.3 }),
  );
  pod.castShadow = true;
  group.add(pod);

  // camera bump (front)
  const cam = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.07, 0.10),
    new THREE.MeshStandardMaterial({ color: 0x0a0c10, roughness: 0.3 }),
  );
  cam.position.set(0, 0.02, 0.14);
  group.add(cam);

  // arms
  const armMat = new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.7 });
  const armGeo = new THREE.BoxGeometry(0.42, 0.03, 0.04);
  const offs = [
    { x:  0.21, z:  0.21, rot:  Math.PI / 4 },
    { x: -0.21, z:  0.21, rot: -Math.PI / 4 },
    { x: -0.21, z: -0.21, rot:  Math.PI / 4 },
    { x:  0.21, z: -0.21, rot: -Math.PI / 4 },
  ];
  const props = [];
  for (let i = 0; i < 4; i++) {
    const o = offs[i];
    const arm = new THREE.Mesh(armGeo, armMat);
    arm.position.set(o.x / 1.5, 0, o.z / 1.5);
    arm.rotation.y = o.rot;
    arm.castShadow = true;
    group.add(arm);

    // motor can
    const motor = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, 0.05, 12),
      new THREE.MeshStandardMaterial({ color: 0x555a66, roughness: 0.4, metalness: 0.6 }),
    );
    motor.position.set(o.x, 0.03, o.z);
    group.add(motor);

    // prop disc (spinning via userData.spin)
    const prop = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.13, 0.005, 16),
      new THREE.MeshStandardMaterial({
        color: 0x88aacc, transparent: true, opacity: 0.35, roughness: 0.2,
      }),
    );
    prop.position.set(o.x, 0.075, o.z);
    prop.userData.isProp = true;
    prop.userData.spinDir = (i % 2 === 0) ? 1 : -1;
    group.add(prop);
    props.push(prop);
  }

  // nav LEDs
  const red = new THREE.Mesh(
    new THREE.SphereGeometry(0.018, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xff3333 }),
  );
  red.position.set(0, 0, 0.16);
  group.add(red);
  const green = new THREE.Mesh(
    new THREE.SphereGeometry(0.018, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0x33ff55 }),
  );
  green.position.set(0, 0, -0.16);
  group.add(green);

  group.userData.props = props;
  return group;
}

// ────────────────────────────────────────────────────────────────────────────
// Electronics + thermal model
// ────────────────────────────────────────────────────────────────────────────
class Electronics {
  constructor() {
    // battery
    this.packVoltageNominal = 25.2;  // 6S
    this.packVoltage = 25.2;
    this.capacity_mAh = 5000;
    this.energyFrac = 1.0;           // 0..1
    this.internalR = 0.06;           // Ω, rises when cold
    // thermals
    this.motorT = 25;
    this.escT = 25;
    this.cpuT = 40;
    this.battT = 25;
    // failures / warnings
    this.motorThrottle = 1.0;        // 0..1, thermal throttle
    this.sensors = { imuNoise: 1, gpsOk: true };
  }

  // ambient: °C, thrustNorm: 0..1, airspeed: m/s, dustLevel: 0..1
  step(dt, ambientC, thrustNorm, airspeed, dustLevel, rainLevel, snowLevel) {
    // Battery internal resistance grows as temperature drops
    // Rough fit: R(T) ≈ R0 * (1 + 0.025*(25 - T_batt))   clamped
    const battDeltaTarget = ambientC + Math.max(0, thrustNorm - 0.4) * 35;
    this.battT += (battDeltaTarget - this.battT) * dt * 0.08;
    this.internalR = Math.max(0.035, 0.06 * (1 + 0.025 * (25 - this.battT)));

    // Current draw ~ quadratic in thrust at hover power ~500W → 20A @ 25V
    const power = 40 + 520 * Math.pow(thrustNorm, 1.6);      // W
    const i = power / Math.max(10, this.packVoltage);         // A
    const vSag = i * this.internalR;
    this.packVoltage = Math.max(14, this.packVoltageNominal - vSag
                                    - (1 - this.energyFrac) * 4.5);

    // Capacity usage (cold air reduces effective capacity)
    const coldCapacityFactor = Math.max(0.45, Math.min(1,
      1 - Math.max(0, (5 - this.battT)) * 0.018));
    const mAh_used = (i * 1000) * (dt / 3600);
    this.energyFrac -= mAh_used / (this.capacity_mAh * coldCapacityFactor);
    this.energyFrac = Math.max(0, this.energyFrac);

    // Motor thermal model: I²R heating, convection cools ~ airspeed
    const motorHeat = 0.9 * Math.pow(thrustNorm, 2.2) * 60; // °C/s at full throttle
    const motorCool = (this.motorT - ambientC) * (0.04 + 0.02 * airspeed);
    this.motorT += (motorHeat - motorCool) * dt;

    // ESC thermal — smaller mass, hotter faster
    const escHeat = 1.1 * Math.pow(thrustNorm, 2.0) * 65;
    const escCool = (this.escT - ambientC) * (0.07 + 0.02 * airspeed);
    this.escT += (escHeat - escCool) * dt;

    // CPU (flight controller): idle + per-step work; slightly cooled by airflow
    const cpuTarget = ambientC + 20 + thrustNorm * 8;
    this.cpuT += (cpuTarget - this.cpuT) * dt * 0.25;

    // Thermal throttling: above 110°C motors lose thrust linearly, cut at 140°C
    if (this.motorT > 110) {
      this.motorThrottle = Math.max(0, 1 - (this.motorT - 110) / 30);
    } else {
      this.motorThrottle = Math.min(1, this.motorThrottle + dt * 0.2);
    }

    // Sensor effects
    // IMU noise ↑ with prop RPM (thrust) and extreme temperatures
    const tempStress = Math.max(0, Math.abs(ambientC - 20) - 30) / 30;
    this.sensors.imuNoise = 1 + thrustNorm * 0.6 + dustLevel * 0.8 + tempStress * 0.5;
    // GPS degraded by heavy precipitation
    const weatherSignal = Math.max(rainLevel * 0.7, snowLevel * 0.5, dustLevel * 0.9);
    this.sensors.gpsOk = weatherSignal < 0.85;
  }

  // Effective thrust multiplier delivered by the motors
  thrustScale() {
    // Brownout protection: below 17V of a 6S pack, output drops
    let v = 1;
    if (this.packVoltage < 19) v = Math.max(0.3, (this.packVoltage - 15) / 4);
    return v * this.motorThrottle * (this.energyFrac > 0 ? 1 : 0);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Drone — rigid body + electronics + visual
// ────────────────────────────────────────────────────────────────────────────
export class Drone {
  // headless=true skips the visible mesh — used by the RL trainer for fast
  // rollouts where rendering would just allocate GPU resources we never use.
  constructor(scene, { headless = false } = {}) {
    this.scene = scene;
    this.headless = headless;
    if (!headless) {
      this.mesh = buildMesh();
      scene.add(this.mesh);
    } else {
      this.mesh = { userData: { props: [] } };  // stub for telemetry path
    }

    // state
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.omega = new THREE.Vector3(); // body angular velocity

    // parameters (rough 2kg cinematic quad)
    this.mass = 2.0;
    this.inertia = new THREE.Vector3(0.015, 0.025, 0.015); // Ix, Iy (yaw), Iz
    this.maxThrust = 4 * 9.81;        // 4× weight peak thrust
    this.dragLin = 0.15;               // linear drag coeff
    this.dragAng = 2.5;                // angular drag
    this.rateTau = 0.04;               // body-rate first-order time constant

    this.electronics = new Electronics();
    this.propSpin = 0;
    this.telemetry = {};
    this.crashed = false;
  }

  reset(pos) {
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.quat.identity();
    this.omega.set(0, 0, 0);
    this.electronics = new Electronics();
    this.crashed = false;
  }

  // inputs: { thrust: 0..1, rateCmd: Vector3 (rad/s) }
  step(dt, inputs, env) {
    // env = { ambientC, wind: Vector3, dustLevel, rainLevel, snowLevel, heightAt(x,z) }
    const I = this.inertia;
    // 1. angular: first-order follow toward rateCmd, plus drag
    const rate = inputs.rateCmd ?? new THREE.Vector3();
    const k = dt / Math.max(dt, this.rateTau);
    this.omega.lerp(rate, k);
    // apply imu noise to perceived rates (not used in physics; for observation)
    // integrate orientation: dq/dt = 0.5 * q * ω_quat
    const omQ = new THREE.Quaternion(this.omega.x, this.omega.y, this.omega.z, 0);
    const dq = new THREE.Quaternion().multiplyQuaternions(this.quat, omQ);
    dq.x *= 0.5; dq.y *= 0.5; dq.z *= 0.5; dq.w *= 0.5;
    this.quat.x += dq.x * dt; this.quat.y += dq.y * dt;
    this.quat.z += dq.z * dt; this.quat.w += dq.w * dt;
    this.quat.normalize();

    // 2. linear: collective thrust along body +Y
    const thrustNorm = Math.max(0, Math.min(1, inputs.thrust ?? 0));
    const effScale = this.electronics.thrustScale();
    // sand in props slightly reduces effective thrust
    const dust = env.dustLevel ?? 0;
    const thrust = this.maxThrust * thrustNorm * effScale * (1 - dust * 0.08);

    const thrustBody = new THREE.Vector3(0, thrust / this.mass, 0);
    const thrustWorld = thrustBody.applyQuaternion(this.quat);

    // wind = relative airflow
    const wind = env.wind ?? new THREE.Vector3();
    const vRel = new THREE.Vector3().subVectors(this.vel, wind);
    const airspeed = vRel.length();

    // drag: proportional to v_rel
    const drag = vRel.clone().multiplyScalar(-this.dragLin);

    // gravity
    const g = new THREE.Vector3(0, -GRAVITY, 0);

    const accel = new THREE.Vector3()
      .add(thrustWorld)
      .add(g)
      .addScaledVector(drag, 1 / this.mass);

    this.vel.addScaledVector(accel, dt);
    this.pos.addScaledVector(this.vel, dt);

    // 3. ground collision (terrain sampled)
    const ground = env.heightAt?.(this.pos.x, this.pos.z) ?? 0;
    const minY = ground + 0.12;
    if (this.pos.y <= minY) {
      this.pos.y = minY;
      // crash if hit fast
      const impact = this.vel.length();
      if (impact > 4) {
        this.crashed = true;
        this.vel.multiplyScalar(-0.2);
      } else {
        this.vel.y = Math.max(0, this.vel.y);
        this.vel.x *= 0.85; this.vel.z *= 0.85;
      }
    }

    // 4. electronics
    this.electronics.step(
      dt,
      env.ambientC ?? 20,
      thrustNorm,
      airspeed,
      dust,
      env.rainLevel ?? 0,
      env.snowLevel ?? 0,
    );

    // 5. visual update (skipped in headless rollouts)
    if (!this.headless) {
      this.mesh.position.copy(this.pos);
      this.mesh.quaternion.copy(this.quat);
      this.propSpin += thrustNorm * 40 * dt;
      for (const p of this.mesh.userData.props) {
        p.rotation.y = this.propSpin * p.userData.spinDir;
      }
    }

    // 6. telemetry
    const euler = new THREE.Euler().setFromQuaternion(this.quat, 'YXZ');
    this.telemetry = {
      alt: this.pos.y,
      agl: Math.max(0, this.pos.y - ground),
      spd: this.vel.length(),
      heading: ((-euler.y * 180 / Math.PI) + 360) % 360,
      pitch: euler.x * 180 / Math.PI,
      roll:  euler.z * 180 / Math.PI,
      thrust: thrustNorm,
      airspeed,
      ambientC: env.ambientC ?? 20,
      battery: this.electronics.energyFrac,
      voltage: this.electronics.packVoltage,
      motorT: this.electronics.motorT,
      escT: this.electronics.escT,
      cpuT: this.electronics.cpuT,
      battT: this.electronics.battT,
      imuNoise: this.electronics.sensors.imuNoise,
      gpsOk: this.electronics.sensors.gpsOk,
      throttle: this.electronics.motorThrottle,
      crashed: this.crashed,
    };
  }
}
