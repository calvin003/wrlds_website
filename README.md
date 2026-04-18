# WRLD — a Genie-3-style promptable world simulator for drone-swarm training

Type a prompt, get an interactive 3D environment populated by a swarm of 50–100 quadcopters training to fly a waypoint course. You're a free-flying observer — walk around, zoom in, or chase the best drone. Snowfall, sandy winds, and ambient temperature are physically coupled to each drone's electronics — cold batteries sag, hot motors throttle, dust degrades IMU/GPS — so the conditions you prompt materially change which policies survive.

## What it is — and what it isn't

Genie 3 (DeepMind, Aug 2025) is a large autoregressive neural world model that generates pixel-level interactive video at 720p/24fps from a text prompt. Training and inference both require significant GPU resources, and the weights aren't public. **This project is not a reimplementation of that neural network.**

What it *is*: the same user-facing contract — type a prompt, get a real-time interactive world with promptable weather events — implemented as a procedural 3D simulator in Three.js. That's arguably closer to what you actually need for drone training anyway, because:

- physics are deterministic and reproducible (same prompt + seed → same world)
- you get exact ground truth for position, wind, and terrain for reward shaping
- it runs on a laptop, not a GPU cluster
- you can scale headless rollouts to thousands per second

## Quick start

The easy way: **double-click `serve.command`**. It starts a local server and opens the page.

The manual way: run `python3 -m http.server` in this folder and visit `http://localhost:8000`.

Why not just double-click `index.html`? Chrome and Safari block ES modules loaded over `file://` for security reasons, so the page will hang on the boot splash. The in-page error panel will tell you this, but `serve.command` skips it entirely.

## Prompting

The parser in `src/prompt.js` converts free text into a `WorldConfig`. It understands:

- **Biomes**: tundra / arctic, desert / dune / sahara, canyon / iceland, forest / taiga, alpine / mountain, urban / rooftops, coast
- **Weather words**: blizzard, snowstorm, snow, flurries, haboob, sandstorm, dust, rain, downpour, drizzle, fog, mist, overcast, clear, calm, windy, gusty
- **Time of day**: dawn, sunrise, noon, golden hour, dusk, night, midnight
- **Numeric**: temperatures like `-25C` or `45°C`, wind like `12 m/s`, `20 mph`, `50 km/h`, altitudes like `200m altitude`

Example prompts:

    first-person drone flight over an icy tundra at dawn, heavy snow, wind 12 m/s, -25C
    narrow canyon in iceland, river at the bottom, moss on rocks, golden hour
    sahara dune sea under a haboob sandstorm, 45C, wind 18 m/s
    alpine mountain ridge at dusk, light snow, -12C, wind 8 m/s

## Interacting

- You're a free observer. **WASD** moves, **Space**/**C** raises/lowers, **Shift** sprints, click the canvas to capture the mouse for look-around.
- The `Cam` button cycles **free → follow (chase the best drone) → orbit (slow auto-orbit of the course)**.
- Sliders on the left override any parsed value *live* — drag ambient °C from -30 to +40 and watch the swarm-wide battery curve respond, or push wind to 25 m/s and see the crash count spike.
- Preset chips regenerate the world with a new biome and reseed the swarm.
- `Reset swarm` reseeds the population (skill priors stay random again — useful for re-running a training experiment).
- `Force evolve` triggers a generation immediately instead of waiting for the 30-second timer.

## Electronics model

In `src/drone.js`, the `Electronics` class couples ambient temperature and weather to:

- **Battery**: 6S LiPo. Internal resistance rises ~2.5% per °C below 25°C; cold air cuts effective capacity up to ~55%; voltage sags under load, causing brownout below ~19V.
- **Motors**: I²R heating from thrust², convective cooling proportional to airspeed. Thermal throttle at 110°C, cut at 140°C.
- **ESCs**: smaller thermal mass, heat faster.
- **CPU**: idles 20°C above ambient, climbs with thrust.
- **IMU**: noise multiplier scales with prop RPM, dust level, and extreme temperature deltas.
- **GPS**: drops lock under heavy precipitation (snow/sand/rain > ~0.85 intensity).

This is what the sliders actually feed into, so "drone training at -35°C in a blizzard" produces a materially different problem from "training at 25°C and calm".

## Training (the visible swarm)

Each of the N drones is its own headless `Drone` instance running the same physics and electronics as before. They share a single `THREE.InstancedMesh` so 80 visible quads cost one draw call.

Per agent there's a *skill* parameter (0–1). The control law is the PID autopilot baseline plus Gaussian exploration noise scaled by `(1 - skill) * explorationScale` — so a skill-0 agent is essentially random twitch and a skill-1 agent flies the autopilot's racing line. Skill is the parameter being optimised.

Every 30 seconds the swarm evolves: bottom 30% by reward are reseeded as mutated copies of a random elite from the top 30% (`skill += N(0, 0.08)`, exploration shrinks). Survivors get a small upward drift. After a few minutes you'll see early-generation drones crashing into terrain while late-generation drones execute clean rounds of the course. The HUD turns colour from red → yellow → cyan-green as mean skill rises.

Reward is shaped by dense distance progress, a +50 bonus on waypoint capture, an efficiency penalty on `thrust²`, and a -30 penalty on crash. Crashes trigger a 1–2 s respawn at a randomised offset around the course start; an agent can crash and respawn many times in one generation.

If you wanted to swap in something fancier (PPO, SAC, neural policies), the cleanest place is `swarm.step()` — the per-agent action source — combined with a per-agent param tensor in `meta`. The `Drone` class is already the environment.

### Bonus: original CEM trainer

`src/trainer.js` still contains an `RLTrainer` (Cross-Entropy Method on a 14-obs → 4-act linear policy) and a fast headless `rollout()`. It isn't wired into the live UI any more, but it's a clean reference if you'd rather optimise offline against the same world.

## File layout

- `index.html` — UI shell
- `src/style.css` — styling
- `src/prompt.js` — text → WorldConfig parser
- `src/world.js` — procedural terrain, biomes, sky, lighting
- `src/weather.js` — wind field + snow / sand / rain particle systems
- `src/drone.js` — rigid-body quadcopter + thermal/electrical sim (supports headless mode)
- `src/swarm.js` — the visible training swarm: instanced rendering, evolutionary optimiser, per-agent rewards
- `src/trainer.js` — PID autopilot, waypoint course, offline CEM trainer
- `src/main.js` — scene graph, render loop, UI wiring

## Known limits

- Terrain is a single 800×800 m patch. Extending to streaming chunks is straightforward but not done here.
- Collision is ground-only; trees and buildings are decorative.
- The prompt parser is keyword-based. Swapping in an LLM call is a ~20-line change in `parsePrompt()`.
- Rendering is forward-lit Three.js — fine for interactivity, not a match for Genie 3's photorealism.
