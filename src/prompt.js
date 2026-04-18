// prompt.js
// Prompt → WorldConfig parser.
//
// Genie 3 feeds prompts through a trained text encoder; we can't replicate that
// here without an LLM, so this is a rule-based keyword parser with numeric
// extraction (e.g. "-25C", "wind 12 m/s"). It's deterministic and fast — good
// enough to drive a simulator and, crucially, easy to audit during drone
// training where you want reproducible scenarios.

// Biomes ordered by specificity — canyon/urban checked before tundra so
// "narrow canyon in iceland" doesn't lose to the substring "ice".
// Keys are matched with word boundaries to avoid "ice" ⊂ "iceland" bugs.
const BIOMES = {
  canyon:   { keys: ['canyon','gorge','ravine','slot canyon','iceland'],          T: 12,  snow: 0,   sand: 0,   ground: 'rock',  terrain: 'canyon',   veg: 'moss'   },
  urban:    { keys: ['urban','city','rooftop','rooftops','downtown','skyscraper'],T: 15,  snow: 0,   sand: 0,   ground: 'asphalt',terrain: 'urban',    veg: 'none'  },
  desert:   { keys: ['desert','sahara','dune','dunes','sandy','sand sea','arid'], T: 38,  snow: 0,   sand: 0.6, ground: 'sand',  terrain: 'dunes',    veg: 'none'   },
  mountain: { keys: ['mountain','alpine','ridge','peak','summit','himalaya'],     T: -5,  snow: 0.3, sand: 0,   ground: 'rock',  terrain: 'alpine',   veg: 'sparse' },
  forest:   { keys: ['forest','pine','woodland','taiga','boreal','jungle'],       T: 8,   snow: 0,   sand: 0,   ground: 'dirt',  terrain: 'rolling',  veg: 'dense'  },
  tundra:   { keys: ['tundra','arctic','polar','icy','glacier','frozen'],         T: -20, snow: 0.7, sand: 0, ground: 'snow',  terrain: 'rolling',  veg: 'sparse' },
  coast:    { keys: ['coast','beach','shore','ocean','lagoon'],                   T: 22,  snow: 0,   sand: 0.1, ground: 'sand',  terrain: 'flat',     veg: 'sparse' },
};
// Word-boundary matcher (handles multi-word keys like "sand sea" too)
function hasWord(text, kw) {
  const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(text);
}

// Weather word → partial override. Merged with MAX for intensity fields so
// stronger words win; 'calm' and 'clear' are handled separately as caps.
const WEATHER_WORDS = {
  blizzard:   { snow: 1.0, wind: 18, vis: 200,  cloud: 1.0 },
  snowstorm:  { snow: 0.9, wind: 14, vis: 400,  cloud: 1.0 },
  snowfall:   { snow: 0.55, wind: 4, vis: 2500, cloud: 0.85 },
  snowing:    { snow: 0.55, wind: 4, vis: 2500, cloud: 0.85 },
  snow:       { snow: 0.6, wind: 4,  vis: 1500, cloud: 0.85 },
  flurries:   { snow: 0.3, wind: 6,  vis: 4000, cloud: 0.6 },
  haboob:     { sand: 1.0, wind: 20, vis: 150,  cloud: 0.3 },
  sandstorm:  { sand: 0.9, wind: 16, vis: 300,  cloud: 0.2 },
  dust:       { sand: 0.4, wind: 10, vis: 2000, cloud: 0.1 },
  downpour:   { rain: 1.0, wind: 10, vis: 1000, cloud: 1.0 },
  rain:       { rain: 0.6, wind: 6,  vis: 3000, cloud: 0.9 },
  drizzle:    { rain: 0.2, wind: 3,  vis: 6000, cloud: 0.7 },
  fog:        { fog:  0.8, wind: 2,  vis: 80,   cloud: 0.6 },
  mist:       { fog:  0.3, wind: 1,  vis: 600,  cloud: 0.4 },
  overcast:   { cloud: 0.9, vis: 8000 },
  windy:      { wind: 12 },
  gusty:      { wind: 10, gust: 18 },
};
// Caps: these clamp *down* (override merged-up values) because they assert a
// negative — "calm" means wind can't be high even if a biome default says 8.
const CAPS = {
  calm:  { wind: 2,  gust: 3 },
  clear: { cloud: 0.1, fog: 0, vis_min: 15000 },
};

const TIMES = {
  dawn:   0.12,
  sunrise:0.18,
  morning:0.30,
  noon:   0.50,
  afternoon:0.60,
  'golden hour': 0.78,
  dusk:   0.82,
  sunset: 0.86,
  twilight:0.92,
  night:  0.02,
  midnight:0.00,
};

// "very cold", "freezing", etc.
const T_WORDS = {
  'extreme cold':-35,'very cold':-25,'freezing':-10,'cold':0,'cool':10,
  'mild':18,'warm':26,'hot':34,'very hot':40,'extreme heat':46,'scorching':48,
};

// parse a single number + unit from text near a keyword
function extractNumber(text, keyword, unitRegex) {
  // pattern: number within 20 chars of keyword (either side)
  const idx = text.indexOf(keyword);
  if (idx < 0) return null;
  const window = text.slice(Math.max(0, idx - 20), Math.min(text.length, idx + 20 + keyword.length));
  const m = window.match(unitRegex);
  return m ? parseFloat(m[1]) : null;
}

// Find temperature expressions like "-25C", "45 °C", "minus 10 degrees"
function extractTemperature(text) {
  // "-25C", "-25 C", "25°C", "-25.5°C"
  let m = text.match(/(-?\d{1,3}(?:\.\d+)?)\s*°?\s*[cC]\b/);
  if (m) return parseFloat(m[1]);
  // "minus 10"
  m = text.match(/minus\s+(\d{1,3})/i);
  if (m) return -parseFloat(m[1]);
  // word-based fallback
  for (const [word, val] of Object.entries(T_WORDS)) {
    if (text.includes(word)) return val;
  }
  return null;
}

function extractWind(text) {
  // "wind 12 m/s", "12 m/s wind", "12 mph"
  let m = text.match(/(\d{1,3}(?:\.\d+)?)\s*m\/?s/);
  if (m) return parseFloat(m[1]);
  m = text.match(/(\d{1,3})\s*mph/i);
  if (m) return parseFloat(m[1]) * 0.447;
  m = text.match(/(\d{1,3})\s*km\/?h/i);
  if (m) return parseFloat(m[1]) * 0.278;
  return null;
}

function extractAltitude(text) {
  let m = text.match(/(\d{2,5})\s*m(?:eters)?\s*(?:altitude|alt|agl|asl|up|high)/);
  if (m) return parseFloat(m[1]);
  if (/low[-\s]?altitude|low\s+level|close\s+to\s+the\s+ground/i.test(text)) return 15;
  if (/high[-\s]?altitude|soaring|cruising\s+altitude/i.test(text)) return 200;
  return null;
}

export function parsePrompt(raw) {
  const text = ' ' + raw.toLowerCase().trim() + ' ';

  // 1. biome — first matching (in declaration order) wins
  let biome = null, biomeName = null;
  for (const [name, b] of Object.entries(BIOMES)) {
    if (b.keys.some(k => hasWord(text, k))) { biome = b; biomeName = name; break; }
  }
  if (!biome) {
    if (/snow|blizzard|arctic|frozen/.test(text)) { biome = BIOMES.tundra; biomeName = 'tundra'; }
    else if (/sand|dune|desert/.test(text))       { biome = BIOMES.desert; biomeName = 'desert'; }
    else                                           { biome = BIOMES.coast;  biomeName = 'coast';  }
  }

  // 2. start from biome defaults
  const cfg = {
    biome: biomeName,
    terrain: biome.terrain,
    ground: biome.ground,
    vegetation: biome.veg,
    ambientC: biome.T,
    wind: 3,
    gust: 0,
    snow: biome.snow,
    sand: biome.sand,
    rain: 0,
    fog: 0,
    cloud: 0.3,
    visibility: 10000,
    timeOfDay: 0.5,
    startAltitude: 25,
    seed: Math.floor(Math.random() * 2**30),
    raw,
  };

  // 3. weather words — *max-merge* for intensities so 'blizzard' beats 'snow'
  //    and stacking words (e.g. "heavy snow and fog") accumulates sensibly.
  for (const [word, mod] of Object.entries(WEATHER_WORDS)) {
    if (!hasWord(text, word)) continue;
    for (const [k, v] of Object.entries(mod)) {
      if (k === 'vis') cfg.visibility = Math.min(cfg.visibility, v);
      else if (['snow','sand','rain','fog','cloud','wind','gust'].includes(k))
        cfg[k] = Math.max(cfg[k] ?? 0, v);
      else cfg[k] = v;
    }
  }
  // intensity modifiers: "heavy snow", "light snow", "heavy rain" etc.
  if (/heavy\s+snow/.test(text))      cfg.snow = Math.max(cfg.snow, 0.95);
  if (/light\s+snow/.test(text))      cfg.snow = Math.min(Math.max(cfg.snow, 0.25), 0.4);
  if (/heavy\s+rain|downpour/.test(text)) cfg.rain = Math.max(cfg.rain, 0.9);
  if (/light\s+rain|drizzle/.test(text))  cfg.rain = Math.min(Math.max(cfg.rain, 0.15), 0.3);
  if (/heavy\s+wind|strong\s+wind/.test(text)) cfg.wind = Math.max(cfg.wind, 14);

  // 3b. caps (calm / clear) — applied AFTER merges so they actually dampen
  for (const [word, caps] of Object.entries(CAPS)) {
    if (!hasWord(text, word)) continue;
    for (const [k, v] of Object.entries(caps)) {
      if (k === 'vis_min') cfg.visibility = Math.max(cfg.visibility, v);
      else cfg[k] = Math.min(cfg[k] ?? v, v);
    }
  }

  // 4. time of day
  for (const [word, t] of Object.entries(TIMES)) {
    if (text.includes(word)) cfg.timeOfDay = t;
  }

  // 5. explicit numeric overrides
  const T = extractTemperature(text);    if (T   !== null) cfg.ambientC = T;
  const W = extractWind(text);           if (W   !== null) cfg.wind = W;
  const A = extractAltitude(text);       if (A   !== null) cfg.startAltitude = A;

  // 6. gust defaults to 1.4× wind if not specified
  if (!cfg.gust) cfg.gust = cfg.wind * 1.4;

  // 7. snow/sand should be zero when ambient forbids it
  if (cfg.ambientC > 2 && biomeName !== 'mountain') cfg.snow = Math.min(cfg.snow, 0.05);
  if (cfg.ambientC < 5) cfg.sand = 0;

  // 8. fog from visibility
  if (cfg.visibility < 500)      cfg.fog = Math.max(cfg.fog, 0.9);
  else if (cfg.visibility < 2000) cfg.fog = Math.max(cfg.fog, 0.5);

  // 9. clamp
  cfg.snow = clamp(cfg.snow, 0, 1);
  cfg.sand = clamp(cfg.sand, 0, 1);
  cfg.rain = clamp(cfg.rain, 0, 1);
  cfg.fog  = clamp(cfg.fog,  0, 1);
  cfg.cloud = clamp(cfg.cloud, 0, 1);
  cfg.wind = clamp(cfg.wind, 0, 30);
  cfg.gust = clamp(cfg.gust, cfg.wind, 35);

  return cfg;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Build a short human-readable echo of what was parsed — useful for HUD.
export function summarize(cfg) {
  const parts = [
    `biome=${cfg.biome}`,
    `T=${cfg.ambientC.toFixed(0)}°C`,
    `wind=${cfg.wind.toFixed(1)}m/s`,
  ];
  if (cfg.snow > 0.1) parts.push(`snow=${(cfg.snow*100).toFixed(0)}%`);
  if (cfg.sand > 0.1) parts.push(`sand=${(cfg.sand*100).toFixed(0)}%`);
  if (cfg.rain > 0.1) parts.push(`rain=${(cfg.rain*100).toFixed(0)}%`);
  if (cfg.fog  > 0.1) parts.push(`fog=${(cfg.fog*100).toFixed(0)}%`);
  parts.push(`tod=${cfg.timeOfDay.toFixed(2)}`);
  parts.push(`seed=${cfg.seed}`);
  return parts.join(' · ');
}
