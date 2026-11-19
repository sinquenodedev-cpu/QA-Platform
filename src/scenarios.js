// Scenario presets and the measurement generator. Generation is deterministic:
// the same settings always produce the same readings.

const DAY_MS = 864e5;

/** Monday 00:00 UTC of the week containing `date`. */
export const weekStart = date => {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY_MS);
};
export const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);

const base = {
  gender: "Female",
  age: 45,
  heightCm: 168,
  startWeightKg: 80,
  kgPerWeek: -0.4,
  noiseKg: 0.3,
  // Days measured per week. Index 0 = this (unfinished) week, 1 = last week, 2 = two weeks ago, ...
  daysPerWeek: [0, 5, 5, 5, 5, 5, 5, 5, 5],
  measurementsPerDay: 1,
  dayPattern: "spread",
  whiteScale: true,
  accountAgeWeeks: 10,
  language: "EN",
};

const preset = (key, title, expect, spec) => ({ key, title, expect, spec: { ...base, label: title, ...spec } });

// The report covers last week; adherence looks at last week and the two before it.
export const PRESETS = [
  preset("high-adherence", "High adherence, balanced loss", "Measurements High · Trend Strong · Pace Balanced",
    { startWeightKg: 82, kgPerWeek: -0.45 }),
  preset("adequate-one-empty-week", "Adequate, one empty week", "Measurements Adequate · Pace Balanced",
    { age: 62, heightCm: 163, startWeightKg: 63.2, kgPerWeek: -0.35, noiseKg: 0.25, daysPerWeek: [1, 7, 7, 0, 5, 5, 4, 5, 5] }),
  preset("low-few-days", "Low adherence, few days", "Measurements Low · Trend Limited",
    { daysPerWeek: [0, 2, 2, 1, 2, 2, 2, 2, 2] }),
  preset("low-two-empty-weeks", "Low adherence, two empty weeks", "Measurements Low (2 empty weeks)",
    { daysPerWeek: [0, 4, 0, 0, 3, 3, 3, 3, 3] }),
  preset("fast-loss", "Fast loss", "Pace Imbalanced",
    { gender: "Male", age: 35, heightCm: 182, startWeightKg: 105, kgPerWeek: -1.2 }),
  preset("slow-loss", "Slow loss", "Pace Steady",
    { age: 50, startWeightKg: 75, kgPerWeek: -0.15 }),
  preset("maintaining", "Maintaining weight", "Pace Steady",
    { age: 30, startWeightKg: 65, kgPerWeek: 0 }),
  preset("gaining", "Gaining weight", "Pace Steady",
    { gender: "Male", age: 45, heightCm: 178, startWeightKg: 85, kgPerWeek: 0.4 }),
  preset("onboarding", "New user (onboarding)", "Measurements Onboarding · Trend Building",
    { accountAgeWeeks: 2, daysPerWeek: [2, 4, 3] }),
  preset("no-activity", "No activity in 3 weeks", "Measurements Inactive",
    { accountAgeWeeks: 20, daysPerWeek: [0, 0, 0, 0, 4, 4, 4, 4, 4, 4] }),
  preset("needs-reactivation", "Last measured 4+ months ago", "Needs reactivation",
    { accountAgeWeeks: 40, daysPerWeek: [...Array(19).fill(0), 4, 4, 4, 4, 4, 4, 4, 4] }),
  preset("black-scale-only", "Black scale only (no BIA)", "No body composition data",
    { whiteScale: false }),
  preset("sunday-only", "Measures on Sundays only", "1 measurement last week (Sunday counted)",
    { daysPerWeek: [0, 1, 1, 1, 1, 1, 1], dayPattern: "sunday" }),
  preset("two-per-day", "Two readings a day", "8 measurements on 4 days",
    { daysPerWeek: [0, 4, 4, 4, 4, 4, 4], measurementsPerDay: 2 }),
  preset("pace-gap-fallback", "Pace with empty comparison weeks", "Pace still shown (compares 4 weeks back)",
    { daysPerWeek: [0, 4, 4, 0, 0, 4, 4, 4] }),
  preset("no-measurements", "Registered, never measured", "Empty report",
    { accountAgeWeeks: 3, daysPerWeek: [0] }),
];

/**
 * What each preset's report must show, checked automatically after creating it.
 * adherence = category; trend/pace = labels the report shows (trend null = hidden);
 * measurements = readings last week; whiteScale = body-composition data present.
 */
const WANT = {
  "high-adherence": { measurements: 5, adherence: "High Adherence", trend: "Strong", pace: "Balanced" },
  "adequate-one-empty-week": { measurements: 7, adherence: "Adequate", trend: "Strong", pace: "Balanced" },
  "low-few-days": { measurements: 2, adherence: "Low Adherence", trend: "Limited" },
  "low-two-empty-weeks": { measurements: 4, adherence: "Low Adherence", trend: "Limited" },
  "fast-loss": { measurements: 5, adherence: "High Adherence", pace: "Imbalanced" },
  "slow-loss": { measurements: 5, adherence: "High Adherence", pace: "Steady" },
  maintaining: { measurements: 5, adherence: "High Adherence", pace: "Steady" },
  gaining: { measurements: 5, adherence: "High Adherence", pace: "Steady" },
  onboarding: { measurements: 4, adherence: "Onboarding", trend: "Building" },
  "no-activity": { measurements: 0, adherence: "No Activity", trend: null, pace: "Unavailable" },
  "needs-reactivation": { measurements: 0, adherence: "Needs reactivation", trend: null, pace: "Unavailable" },
  "black-scale-only": { measurements: 5, adherence: "High Adherence", whiteScale: false },
  "sunday-only": { measurements: 1, adherence: "Low Adherence", trend: null },
  "two-per-day": { measurements: 8, adherence: "High Adherence", trend: "Strong" },
  "pace-gap-fallback": { measurements: 4, adherence: "Adequate", pace: "Balanced" },
  "no-measurements": { measurements: 0, trend: null, pace: "Unavailable" },
};
for (const p of PRESETS) p.want = WANT[p.key] || {};

// Monday = 0 ... Sunday = 6
const DAY_ORDER = {
  spread: [0, 2, 4, 6, 1, 3, 5],
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  sunday: [6, 5, 4, 3, 2, 1, 0],
};

const seeded = seed => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const r1 = v => Math.round(v * 10) / 10;

/** Plausible white-scale (BIA) values for a weight. */
export const biaValues = (weightKg, { gender, age, heightCm, startWeightKg }) => {
  const male = gender === "Male";
  const bmi = weightKg / Math.pow(heightCm / 100, 2);
  const bfr = (male ? 24 : 32) + (weightKg - startWeightKg) * 0.5;
  const fatMass = (weightKg * bfr) / 100;
  const lean = weightKg - fatMass;
  const muscle = lean * 0.52;
  const protein = lean * 0.2;
  return {
    weight_bia: r1(weightKg),
    bmi_bia: r1(bmi),
    bfr_bia: r1(bfr),
    sfr_bia: r1(bfr * 0.8),
    uvi_bia: Math.max(1, Math.min(15, Math.round((bmi - 18) / 1.5))),
    rom_bia: r1((muscle / weightKg) * 100),
    bmr_bia: Math.round(10 * weightKg + 6.25 * heightCm - 5 * age + (male ? 5 : -161)),
    bm_bia: 2.5,
    vwc_bia: r1(100 - bfr - 18),
    physicalAge_bia: age,
    pp_bia: r1((protein / weightKg) * 100),
    fatMass_bia: r1(fatMass),
    leanBodyMass_bia: r1(lean),
    muscleMass_bia: r1(muscle),
    proteinMass_bia: r1(protein),
    impedence: 500,
  };
};

export const BIA_COLUMNS = Object.keys(biaValues(70, { gender: "Female", age: 40, heightCm: 170, startWeightKg: 70 }));

/** Readings for a scenario, relative to `now`. Moments in the future are skipped. */
export const generateMeasurements = (spec, now = new Date()) => {
  const rand = seeded(hash(JSON.stringify(spec)));
  const currentMonday = weekStart(now);
  const oldest = spec.daysPerWeek.length - 1;
  const firstMonday = addDays(currentMonday, -7 * oldest);
  const out = [];

  for (let weeksAgo = oldest; weeksAgo >= 0; weeksAgo--) {
    const days = Math.max(0, Math.min(7, Math.floor(spec.daysPerWeek[weeksAgo] ?? 0)));
    const monday = addDays(currentMonday, -7 * weeksAgo);
    const offsets = DAY_ORDER[spec.dayPattern].slice(0, days).sort((a, b) => a - b);

    for (const offset of offsets) {
      for (let k = 0; k < Math.max(1, spec.measurementsPerDay); k++) {
        const date = addDays(monday, offset);
        date.setUTCHours(7 + k * 5, Math.floor(rand() * 50), 0, 0);
        if (date > now) continue;
        const weeksIn = (date - firstMonday) / (7 * DAY_MS);
        const weight = spec.startWeightKg + spec.kgPerWeek * weeksIn + (rand() * 2 - 1) * spec.noiseKg;
        out.push({
          measurement_date: date,
          net_weight: Math.round(weight * 100) / 100,
          bia: spec.whiteScale ? biaValues(weight, spec) : null,
        });
      }
    }
  }
  return out;
};
