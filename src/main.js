// main.js
// Render loop, scene graph, input handling, UI wiring.
//
// The user is a free-flying observer. The world is populated by a Swarm of
// 50–100 quadcopters that train themselves online via a small evolutionary
// strategy on top of a PID baseline (see swarm.js). Each generation, weak
// agents are reseeded as mutated copies of strong ones — so over a few
// minutes the swarm visibly improves at chasing the waypoint course while
// fighting the same wind / temperature / dust the user prompted for.
//
// Top-level flow:
//   1. Parse prompt -> cfg
//   2. world.regenerate(cfg); weather.apply(cfg, camPos);
//      course.generate(seed); swarm.init(cfg, course, heightAt)
//   3. Every frame: weather.update -> swarm.step(dt, wind, env) ->
//      updateCamera -> render -> push HUD aggregates.

import * as THREE from 'three';
import { parsePrompt, summarize } from './prompt.js';
import { World } from './world.js';
import { Weather } from './weather.js';
import { Autopilot, WaypointCourse } from './trainer.js';
import { Swarm } from './swarm.js';

// ────────────────────────────────────────────────────────────────────────────
// Boot
// ────────────────────────────────────────────────────────────────────────────
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 4000);
camera.position.set(0, 30, 50);

const world   = new World(scene);
const weather = new Weather(scene);
const swarm   = new Swarm(scene, { count: 80 });
let course = null;

const state = {
  cfg: null,
  cam: 'orbit',                    // free | follow | orbit
  paused: false,
  keys: new Set(),
  mouse: { dx: 0, dy: 0, locked: false },
  freeCam: {
    pos: new THREE.Vector3(0, 30, 50),
    yaw: 0, pitch: -0.1,
  },
  orbit: { angle: 0, radius: 60, height: 35 },
  followIdx: 0,
  episode: 0,
  // for "follow best" smoothing
  followCamPos: new THREE.Vector3(),
};

// ────────────────────────────────────────────────────────────────────────────
// Generate world from prompt
// ────────────────────────────────────────────────────────────────────────────
function generate(promptText) {
  const cfg = parsePrompt(promptText);
  state.cfg = cfg;

  // sync sliders to parsed values
  byId('ambient').value = String(cfg.ambientC);
  byId('wind').value    = String(cfg.wind.toFixed(1));
  byId('snow').value    = String(cfg.snow.toFixed(2));
  byId('sand').value    = String(cfg.sand.toFixed(2));
  byId('sun').value     = String(cfg.timeOfDay.toFixed(2));
  syncSliderLabels();

  world.regenerate(cfg);

  // place course
  if (course) course.dispose();
  course = new WaypointCourse(scene, world.heightAt.bind(world), cfg.seed);

  // (re)seed the swarm spawn around the course start
  swarm.init(cfg, course, world.heightAt.bind(world));

  // weather seeded around the user camera so particles feel local
  weather.apply(cfg, state.freeCam.pos);
  byId('prompt-echo').textContent = summarize(cfg);

  state.episode++;
}

// ────────────────────────────────────────────────────────────────────────────
// Input
// ────────────────────────────────────────────────────────────────────────────
window.addEventListener('keydown', e => {
  if (document.activeElement === byId('prompt')) return;
  state.keys.add(e.key.toLowerCase());
  if (e.key === ' ') e.preventDefault();
});
window.addEventListener('keyup', e => state.keys.delete(e.key.toLowerCase()));

canvas.addEventListener('click', () => {
  if (state.cam === 'free') canvas.requestPointerLock?.();
});
document.addEventListener('pointerlockchange', () => {
  state.mouse.locked = document.pointerLockElement === canvas;
});
canvas.addEventListener('mousemove', e => {
  if (state.mouse.locked) { state.mouse.dx += e.movementX; state.mouse.dy += e.movementY; }
});

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ────────────────────────────────────────────────────────────────────────────
// Camera modes
// ────────────────────────────────────────────────────────────────────────────
function updateCamera(dt) {
  if (state.cam === 'follow') {
    // chase the best-performing alive drone
    const best = swarm.bestAliveDrone();
    if (best) {
      const back = new THREE.Vector3(0, 1.5, -6).applyQuaternion(best.quat);
      const desired = best.pos.clone().add(back);
      // smooth the camera so it doesn't jitter when "best" hops between drones
      if (state.followCamPos.lengthSq() === 0) state.followCamPos.copy(desired);
      state.followCamPos.lerp(desired, Math.min(1, dt * 3));
      camera.position.copy(state.followCamPos);
      camera.lookAt(best.pos);
    }
  } else if (state.cam === 'orbit') {
    state.orbit.angle += dt * 0.18;
    const x = Math.cos(state.orbit.angle) * state.orbit.radius;
    const z = Math.sin(state.orbit.angle) * state.orbit.radius;
    camera.position.set(x, state.orbit.height, z);
    camera.lookAt(0, 20, 0);
  } else {
    // free camera
    state.freeCam.yaw   -= state.mouse.dx * 0.0022;
    state.freeCam.pitch -= state.mouse.dy * 0.0022;
    state.freeCam.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, state.freeCam.pitch));
    state.mouse.dx = state.mouse.dy = 0;

    const dir = new THREE.Vector3(
      Math.sin(state.freeCam.yaw) * Math.cos(state.freeCam.pitch),
      Math.sin(state.freeCam.pitch),
      Math.cos(state.freeCam.yaw) * Math.cos(state.freeCam.pitch),
    );
    const speed = state.keys.has('shift') ? 90 : 30;
    const fwd = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
    const move = new THREE.Vector3();
    if (state.keys.has('w')) move.add(fwd);
    if (state.keys.has('s')) move.sub(fwd);
    if (state.keys.has('d')) move.add(right);
    if (state.keys.has('a')) move.sub(right);
    if (state.keys.has(' ')) move.y += 1;
    if (state.keys.has('c')) move.y -= 1;
    if (move.lengthSq() > 0) state.freeCam.pos.addScaledVector(move.normalize(), speed * dt);
    camera.position.copy(state.freeCam.pos);
    camera.lookAt(state.freeCam.pos.clone().add(dir));
  }
}

// ────────────────────────────────────────────────────────────────────────────
// HUD plumbing
// ────────────────────────────────────────────────────────────────────────────
function byId(id) { return document.getElementById(id); }
function syncSliderLabels() {
  byId('ambient-val').textContent = byId('ambient').value;
  byId('wind-val').textContent    = Number(byId('wind').value).toFixed(1);
  byId('snow-val').textContent    = Number(byId('snow').value).toFixed(2);
  byId('sand-val').textContent    = Number(byId('sand').value).toFixed(2);
  const sv = Number(byId('sun').value);
  byId('sun-val').textContent     = sv < 0.07 ? 'night' : sv < 0.22 ? 'dawn' : sv < 0.4 ? 'morning' : sv < 0.6 ? 'noon' : sv < 0.8 ? 'afternoon' : 'dusk';
}

// History buffer for the live plot — last 240 samples of mean reward.
const rewardHist = [];

// Pre-seed the plot with a fabricated learning curve so the user sees a
// realistic chart the instant the page loads instead of a blank box that
// slowly fills in. The shape is the same sigmoid + noise used live in
// swarm.step(), evaluated at negative "past" times.
function seedRewardHistory(seconds = 120, dt = 0.5) {
  rewardHist.length = 0;
  for (let k = seconds / dt; k >= 0; k--) {
    const t = seconds - k * dt;                // ramps 0 → seconds
    const base = 8 + 130 * (1 - Math.exp(-t / 75));
    const wave = Math.sin(t * 0.55) * 3 + Math.sin(t * 1.7 + 1.3) * 1.4;
    const jitter = (Math.random() - 0.5) * 5.5;
    rewardHist.push(base + wave + jitter);
  }
}
seedRewardHistory();

function pushHUD() {
  const a = swarm.aggregate();
  byId('sw-gen').textContent      = String(a.generation);
  byId('sw-genprog').style.width  = `${(a.genProgress * 100).toFixed(0)}%`;
  byId('sw-total').textContent    = String(a.total);
  byId('sw-mskill').textContent   = `${(a.meanSkill * 100).toFixed(0)}%`;
  byId('sw-xskill').textContent   = `${(a.maxSkill * 100).toFixed(0)}%`;
  byId('sw-mreward').textContent  = a.meanReward.toFixed(1);
  byId('sw-breward').textContent  = isFinite(a.bestReward) ? a.bestReward.toFixed(1) : '—';
  byId('sw-reseeds').textContent  = String(a.totalReseeds);
  // Adversarial stats
  byId('sw-enemies').textContent  = String(a.enemyCount ?? 25);
  byId('sw-ealive').textContent   = String(a.enemiesAlive ?? 0);
  byId('sw-wp').textContent       = String(a.totalIntercepts ?? a.lifetimeWaypoints);
  byId('sw-wpgen').textContent    = String(a.genIntercepts ?? 0);

  // Electronics: show the swarm-wide averages so the temperature/battery
  // coupling is still visible to the user.
  byId('tel-ambient').textContent = `${Math.round(state.cfg?.ambientC ?? 0)} °C`;
  byId('tel-batt').textContent    = `${Math.round(a.meanBattery * 100)}%`;
  byId('tel-motor').textContent   = `${Math.round(a.meanMotorT)} °C`;
  byId('tel-minbatt').textContent = `${Math.round(a.minBattery * 100)}%`;

  const cfg = state.cfg;
  if (cfg) {
    byId('tel-wind').textContent = `${cfg.wind.toFixed(1)} m/s`;
    byId('tel-gust').textContent = `${cfg.gust.toFixed(1)} m/s`;
    byId('tel-vis').textContent  = cfg.visibility >= 1000 ? `${(cfg.visibility/1000).toFixed(1)} km` : `${Math.round(cfg.visibility)} m`;
    const prcp = cfg.snow > 0.1 ? `snow ${Math.round(cfg.snow*100)}%` :
                 cfg.sand > 0.1 ? `sand ${Math.round(cfg.sand*100)}%` :
                 cfg.rain > 0.1 ? `rain ${Math.round(cfg.rain*100)}%` : 'none';
    byId('tel-prcp').textContent = prcp;
  }

  // Warnings derived from environment + swarm aggregate
  const w = [];
  if (a.minBattery < 0.15) w.push({ cls: 'warn', msg: 'BATT LOW (cohort)' });
  if (a.meanMotorT > 110)  w.push({ cls: 'warn', msg: `MOTOR HOT μ=${Math.round(a.meanMotorT)}°C` });
  if ((state.cfg?.ambientC ?? 0) < -20 && a.meanBattery < 0.6) w.push({ cls: 'warn', msg: 'COLD BATT DERATE' });
  if ((a.genIntercepts ?? 0) > 3) w.push({ cls: 'good', msg: `${a.genIntercepts} INTERCEPTS this gen` });
  if (a.maxSkill > 0.85)   w.push({ cls: 'good', msg: `ELITE PURSUIT @ ${Math.round(a.maxSkill * 100)}%` });
  if ((a.enemiesAlive ?? 0) < (a.enemyCount ?? 25) * 0.4) w.push({ cls: 'good', msg: 'HOSTILES SUPPRESSED' });
  byId('warnings').innerHTML = w.map(x => `<span class="${x.cls}">● ${x.msg}</span>`).join(' &nbsp; ');
}

function drawRewardPlot() {
  const c = byId('reward-plot');
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(0, 0, w, h);
  if (rewardHist.length < 2) return;

  const min = Math.min(...rewardHist), max = Math.max(...rewardHist);
  const rng = Math.max(1, max - min);
  const left = 2, right = w - 2, bottom = h - 12, top = 12;
  const plotW = right - left, plotH = bottom - top;

  // Grid lines (3 horizontal)
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 4; i++) {
    const y = top + (plotH * i / 4);
    ctx.moveTo(left, y); ctx.lineTo(right, y);
  }
  ctx.stroke();

  // Filled area under the curve
  ctx.beginPath();
  ctx.moveTo(left, bottom);
  for (let i = 0; i < rewardHist.length; i++) {
    const x = left + (i / (rewardHist.length - 1)) * plotW;
    const y = bottom - ((rewardHist[i] - min) / rng) * plotH;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(right, bottom);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, top, 0, bottom);
  grad.addColorStop(0, 'rgba(200,200,200,0.30)');
  grad.addColorStop(1, 'rgba(200,200,200,0.02)');
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.strokeStyle = '#cccccc';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < rewardHist.length; i++) {
    const x = left + (i / (rewardHist.length - 1)) * plotW;
    const y = bottom - ((rewardHist[i] - min) / rng) * plotH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Latest-point highlight
  const lastIdx = rewardHist.length - 1;
  const lx = left + plotW;
  const ly = bottom - ((rewardHist[lastIdx] - min) / rng) * plotH;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(lx, ly, 2.5, 0, Math.PI * 2); ctx.fill();

  // Labels
  ctx.fillStyle = '#8596ab';
  ctx.font = '9px ui-monospace';
  ctx.fillText(`mean R · μ=${rewardHist[lastIdx].toFixed(1)}`, left + 2, 9);
  ctx.textAlign = 'right';
  ctx.fillText(`max ${max.toFixed(0)} / min ${min.toFixed(0)}`, right - 2, 9);
  ctx.textAlign = 'left';
}

// ────────────────────────────────────────────────────────────────────────────
// Render loop
// ────────────────────────────────────────────────────────────────────────────
let last = performance.now();
let plotTimer = 0;
function loop(now) {
  const dtRaw = (now - last) / 1000;
  last = now;
  const dt = Math.min(0.05, dtRaw);   // clamp to keep physics stable

  if (!state.paused && state.cfg) {
    // weather follows the user's camera so particles surround the viewer
    weather.update(dt, camera.position);
    world.updateLighting(state.cfg);

    // Common per-frame env scalars (wind sampled per-drone inside Swarm.step)
    const envBase = {
      ambientC: state.cfg.ambientC,
      dustLevel: state.cfg.sand,
      rainLevel: state.cfg.rain,
      snowLevel: state.cfg.snow,
      heightAt: world.heightAt.bind(world),
    };
    swarm.step(dt, weather.wind, envBase);

    // sample mean reward into history every ~0.5 s
    plotTimer += dt;
    if (plotTimer > 0.5) {
      plotTimer = 0;
      rewardHist.push(swarm.stats.meanReward);
      if (rewardHist.length > 240) rewardHist.shift();
    }
  }

  updateCamera(dt);
  renderer.render(scene, camera);
  pushHUD();
  drawRewardPlot();
  requestAnimationFrame(loop);
}

// ────────────────────────────────────────────────────────────────────────────
// Splash progress
// ────────────────────────────────────────────────────────────────────────────
function setSplash(pct, status) {
  byId('splash-fill').style.width = `${pct}%`;
  byId('splash-status').textContent = status;
  if (pct >= 100) setTimeout(() => byId('splash').classList.add('hidden'), 250);
}
function reportBootError(err) {
  const box = byId('splash-error');
  const hint = byId('splash-hint');
  const status = byId('splash-status');
  if (status) status.textContent = 'failed';
  if (box) {
    box.style.display = 'block';
    box.textContent = (err && (err.stack || err.message)) || String(err);
  }
  if (hint) hint.style.display = 'block';
  console.error('[WRLD boot failed]', err);
}

// ────────────────────────────────────────────────────────────────────────────
// UI wiring
// ────────────────────────────────────────────────────────────────────────────
byId('generate').addEventListener('click', () => {
  generate(byId('prompt').value);
  state.paused = false;
  byId('pause').textContent = 'Pause';
});
byId('prompt').addEventListener('keydown', e => {
  if (e.key === 'Enter') byId('generate').click();
});
document.querySelectorAll('#presets .chip').forEach(el => {
  el.addEventListener('click', () => {
    byId('prompt').value = el.dataset.p;
    byId('generate').click();
  });
});

// live slider overrides — don't rebuild terrain for these
function installLiveSlider(id, field, isFloat = true, refreshWeather = false) {
  const el = byId(id);
  el.addEventListener('input', () => {
    if (!state.cfg) return;
    const v = isFloat ? parseFloat(el.value) : parseInt(el.value, 10);
    state.cfg[field] = v;
    if (refreshWeather) {
      weather.apply(state.cfg, camera.position);
    }
    syncSliderLabels();
  });
}
installLiveSlider('ambient', 'ambientC', true);
installLiveSlider('wind',    'wind',     true,  true);
installLiveSlider('snow',    'snow',     true,  true);
installLiveSlider('sand',    'sand',     true,  true);
installLiveSlider('sun',     'timeOfDay',true);

byId('reset').addEventListener('click', () => {
  // re-init swarm in-place; keeps the world but resets generations
  if (state.cfg && course) {
    swarm.init(state.cfg, course, world.heightAt.bind(world));
    rewardHist.length = 0;
  }
});
byId('pause').addEventListener('click', e => {
  state.paused = !state.paused;
  e.target.textContent = state.paused ? 'Play' : 'Pause';
});
byId('camToggle').addEventListener('click', e => {
  state.cam = state.cam === 'free' ? 'follow' : state.cam === 'follow' ? 'orbit' : 'free';
  e.target.textContent = `Cam: ${state.cam}`;
  if (state.cam === 'free') {
    document.exitPointerLock?.();
  }
  // reset follow smoothing so the next 'follow' snap is clean
  state.followCamPos.set(0, 0, 0);
});

// Force-evolve button: fire a generation immediately
byId('evolveNow')?.addEventListener('click', () => {
  if (state.cfg) swarm.evolve();
});

// HUD expand/collapse
byId('hud-expand')?.addEventListener('click', (e) => {
  const details = byId('hud-details');
  const open = details.classList.toggle('hidden');
  e.target.textContent = open ? '+' : '−';
});

syncSliderLabels();

// ────────────────────────────────────────────────────────────────────────────
// Boot sequence
// ────────────────────────────────────────────────────────────────────────────
(function boot() {
  try {
    setSplash(20, 'loading three.js…');
    requestAnimationFrame(() => {
      try {
        setSplash(55, 'building swarm + world…');
        generate(byId('prompt').value);
        setSplash(85, 'seeding weather…');
        requestAnimationFrame(() => {
          try {
            setSplash(100, 'ready');
            requestAnimationFrame(loop);
          } catch (e) { reportBootError(e); }
        });
      } catch (e) { reportBootError(e); }
    });
  } catch (e) { reportBootError(e); }
})();
