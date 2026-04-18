import { parsePrompt, summarize } from '../src/prompt.js';

const prompts = [
  "first-person drone flight over an icy tundra at dawn, heavy snow, wind 12 m/s, -25C",
  "narrow canyon in iceland, river at the bottom, moss on rocks, golden hour",
  "sahara dune sea under a haboob sandstorm, 45C, wind 18 m/s",
  "arctic tundra blizzard, -35C, wind 20 m/s, heavy snow, night",
  "dense pine forest after snowfall, calm, -5C, noon",
  "urban rooftops at night, cold rain, 4C, wind 10 m/s",
];

for (const p of prompts) {
  const cfg = parsePrompt(p);
  console.log("PROMPT:", p);
  console.log("  ->", summarize(cfg));
  console.log("     biome=%s terrain=%s ground=%s veg=%s", cfg.biome, cfg.terrain, cfg.ground, cfg.vegetation);
  console.log("     T=%s wind=%s snow=%s sand=%s rain=%s fog=%s tod=%s vis=%s",
    cfg.ambientC, cfg.wind.toFixed(1), cfg.snow.toFixed(2), cfg.sand.toFixed(2),
    cfg.rain.toFixed(2), cfg.fog.toFixed(2), cfg.timeOfDay.toFixed(2), cfg.visibility);
  console.log();
}
