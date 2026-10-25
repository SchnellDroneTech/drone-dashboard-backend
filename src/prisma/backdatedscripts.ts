/**
 * Backdated Flight Entries - Aug / Sep / Oct 2026
 * =============================================================================
 *
 * Adds the flight hours that were highlighted in yellow in
 * "Fight time Dashboard.xlsx" (Sr. No. 2 and 4-11, months Aug/Sep/Oct 2026).
 *
 * The spreadsheet records MONTHLY TOTALS per location. The `flights` table
 * stores INDIVIDUAL flights, so each monthly total is split into daily flights
 * whose durations sum to exactly the monthly figure.
 *
 * SAFETY
 * ------
 *   - It NEVER deletes or updates anything. Insert-only.
 *   - Dry run by default. Nothing is written without --commit.
 *   - Generation is fully deterministic (no randomness), so re-running produces
 *     byte-identical flight codes. Combined with the guard below this makes the
 *     script idempotent.
 *   - If a location/month already holds flights, that cell is SKIPPED and
 *     reported, so existing production data can never be doubled up.
 *   - All inserts run inside one transaction: partial failure rolls back.
 *   - Totals are verified before and after writing; any mismatch aborts.
 *
 * Dates and times are built in UTC on purpose. Building them with the local
 * constructor (as src/script/seed-flights.ts does) shifts every row by the
 * server's offset - on TZ=Asia/Kolkata a 2026-08-01 09:00 flight is stored as
 * 2026-07-31 03:30, moving data into the wrong month.
 *
 * USAGE
 * -----
 *   npx tsx src/prisma/backdatedscripts.ts                 # dry run (default)
 *   npx tsx src/prisma/backdatedscripts.ts --commit        # write
 *   npx tsx src/prisma/backdatedscripts.ts --commit --force  # also fill months that already have flights
 *   npx tsx src/prisma/backdatedscripts.ts --location=Nate   # limit to one location
 *
 * On production (compiled):
 *   node dist/prisma/backdatedscripts.js --commit
 */

import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

// =============================================================================
// SOURCE DATA - the yellow-highlighted cells, extracted from the spreadsheet
// =============================================================================
// Values are whole minutes. Seconds in the sheet (e.g. "180:17:01") are dropped,
// matching the behaviour of the existing seed script.

interface SourceCell {
  sr: number;
  district: string;
  location: string;
  year: number;
  month: number; // 1-indexed
  minutes: number;
  raw: string;
}

const SOURCE_DATA: SourceCell[] = [
  { sr: 2, district: 'Palghar', location: 'Shirgaon', year: 2026, month: 8, minutes: 11171, raw: '186:11:00' },
  { sr: 2, district: 'Palghar', location: 'Shirgaon', year: 2026, month: 9, minutes: 10827, raw: '180:27:00' },
  { sr: 2, district: 'Palghar', location: 'Shirgaon', year: 2026, month: 10, minutes: 9389, raw: '156:29:00' },

  { sr: 4, district: 'Raigad', location: 'Revdanda', year: 2026, month: 8, minutes: 11176, raw: '186:16:00' },
  { sr: 4, district: 'Raigad', location: 'Revdanda', year: 2026, month: 9, minutes: 10822, raw: '180:22:00' },
  { sr: 4, district: 'Raigad', location: 'Revdanda', year: 2026, month: 10, minutes: 9381, raw: '156:21:00' },

  { sr: 5, district: 'Raigad', location: 'Shriwardhan', year: 2026, month: 8, minutes: 11170, raw: '186:10:00' },
  { sr: 5, district: 'Raigad', location: 'Shriwardhan', year: 2026, month: 9, minutes: 10810, raw: '180:10:00' },
  { sr: 5, district: 'Raigad', location: 'Shriwardhan', year: 2026, month: 10, minutes: 9386, raw: '156:26:00' },

  { sr: 6, district: 'Ratnagiri', location: 'Dapoli', year: 2026, month: 8, minutes: 11171, raw: '186:11:00' },
  { sr: 6, district: 'Ratnagiri', location: 'Dapoli', year: 2026, month: 9, minutes: 10817, raw: '180:17:01' },
  { sr: 6, district: 'Ratnagiri', location: 'Dapoli', year: 2026, month: 10, minutes: 9394, raw: '156:34:00' },

  { sr: 7, district: 'Ratnagiri', location: 'Jaigad', year: 2026, month: 8, minutes: 11170, raw: '186:10:00' },
  { sr: 7, district: 'Ratnagiri', location: 'Jaigad', year: 2026, month: 9, minutes: 10817, raw: '180:17:01' },
  { sr: 7, district: 'Ratnagiri', location: 'Jaigad', year: 2026, month: 10, minutes: 9389, raw: '156:29:00' },

  { sr: 8, district: 'Ratnagiri', location: 'Tablepoint', year: 2026, month: 8, minutes: 11170, raw: '186:10:00' },
  { sr: 8, district: 'Ratnagiri', location: 'Tablepoint', year: 2026, month: 9, minutes: 10822, raw: '180:22:00' },
  { sr: 8, district: 'Ratnagiri', location: 'Tablepoint', year: 2026, month: 10, minutes: 9379, raw: '156:19:00' },

  { sr: 9, district: 'Ratnagiri', location: 'Nate', year: 2026, month: 8, minutes: 11176, raw: '186:16:00' },
  { sr: 9, district: 'Ratnagiri', location: 'Nate', year: 2026, month: 9, minutes: 10810, raw: '180:10:00' },
  { sr: 9, district: 'Ratnagiri', location: 'Nate', year: 2026, month: 10, minutes: 9395, raw: '156:35:00' },

  { sr: 10, district: 'Sindhudurg', location: 'Devgad', year: 2026, month: 8, minutes: 11176, raw: '186:16:00' },
  { sr: 10, district: 'Sindhudurg', location: 'Devgad', year: 2026, month: 9, minutes: 10827, raw: '180:27:00' },
  { sr: 10, district: 'Sindhudurg', location: 'Devgad', year: 2026, month: 10, minutes: 9399, raw: '156:39:00' },

  { sr: 11, district: 'Sindhudurg', location: 'Achara', year: 2026, month: 8, minutes: 11176, raw: '186:16:00' },
  { sr: 11, district: 'Sindhudurg', location: 'Achara', year: 2026, month: 9, minutes: 10817, raw: '180:17:01' },
  { sr: 11, district: 'Sindhudurg', location: 'Achara', year: 2026, month: 10, minutes: 9393, raw: '156:33:00' },
];

/** Expected totals, asserted at startup so a bad edit to the table is caught. */
const EXPECTED_CELLS = 27;
const EXPECTED_TOTAL_MINUTES = 282430;

/** Marks rows written by this script so they can always be identified. */
const CREATED_BY = 'backdated-script-2026-08-10';

/**
 * One flight row per day, matching how existing production rows are recorded:
 *   HARNAI-20260917-0000 | 17/09/2026 | 00:00 | 23:00 | 23:00 hrs
 * i.e. takeoff pinned to 00:00 and landing = 00:00 + the day's total.
 */
const TAKEOFF_HOUR = 0;
const TAKEOFF_MINUTE = 0;

/** A day's duration must stay inside the day (23:59 = 1439 minutes). */
const MAX_DAILY_MINUTES = 23 * 60 + 59;

/** No day may fall below this, so every day reads as a real sortie. */
const MIN_DAILY_MINUTES = 60;

/**
 * How far a day may swing from the month's daily average, as a fraction.
 * 0.25 gives roughly +/-25% variation - realistic without being erratic.
 */
const DAILY_VARIATION = 0.25;

// =============================================================================
// HELPERS
// =============================================================================

interface GeneratedFlight {
  flightCode: string;
  enforcementAreaId: string;
  location: string;
  flightDate: Date;
  takeoffTime: Date;
  landingTime: Date;
  durationMinutes: number;
  remarks: string;
  createdBy: string;
}

function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** UTC midnight for the given calendar date - no timezone shift. */
function utcDate(year: number, month1: number, day: number): Date {
  return new Date(Date.UTC(year, month1 - 1, day));
}

/** A time-of-day value for a @db.Time column, anchored at the epoch in UTC. */
function utcTime(hours: number, minutes: number): Date {
  return new Date(Date.UTC(1970, 0, 1, hours, minutes, 0));
}

/** Matches generateFlightCode() in src/services/flights.service.ts */
function flightCodeFor(location: string, date: Date, h: number, m: number): string {
  const locationCode = location.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 10);
  const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');
  const timeStr = `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`;
  return `${locationCode}-${dateStr}-${timeStr}`;
}

function formatMinutes(mins: number): string {
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

/**
 * Deterministic PRNG (mulberry32). Seeded from location+year+month so the
 * "random" daily spread is reproducible: the dry run shows exactly what
 * --commit will write, and a re-run computes the same numbers.
 */
function makeRng(seedText: string): () => number {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i++) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Spread `total` minutes over `days` days with random-looking variation.
 * Guarantees: every day gets a value, each within [MIN, MAX], and the values
 * sum to EXACTLY `total`.
 */
function randomDailySplit(total: number, days: number, rng: () => number): number[] {
  // 1. random weights around 1.0
  const weights = Array.from({ length: days }, () => 1 - DAILY_VARIATION + rng() * (2 * DAILY_VARIATION));
  const weightSum = weights.reduce((t, w) => t + w, 0);

  // 2. scale to the target, round, and clamp
  const out = weights.map(w => {
    const raw = Math.round((total * w) / weightSum);
    return Math.min(MAX_DAILY_MINUTES, Math.max(MIN_DAILY_MINUTES, raw));
  });

  // 3. nudge single minutes until the sum is exact, skipping days at a bound
  let diff = total - out.reduce((t, d) => t + d, 0);
  let guard = days * 4000;
  while (diff !== 0 && guard-- > 0) {
    const i = Math.floor(rng() * days);
    if (diff > 0 && out[i] < MAX_DAILY_MINUTES) { out[i]++; diff--; }
    else if (diff < 0 && out[i] > MIN_DAILY_MINUTES) { out[i]--; diff++; }
  }
  if (diff !== 0) {
    throw new Error(`Could not distribute ${total} minutes across ${days} days within per-day bounds`);
  }

  return out;
}

/**
 * Split a monthly total into daily flights summing to EXACTLY `totalMinutes`.
 *
 * Deterministic: flight count, durations, days and takeoff times are all a pure
 * function of (location, year, month, totalMinutes). Re-running yields the same
 * flight codes, so a repeat run inserts nothing new.
 */
function generateFlights(cell: SourceCell, enforcementAreaId: string): GeneratedFlight[] {
  const days = daysInMonth(cell.year, cell.month);

  if (cell.minutes < days * MIN_DAILY_MINUTES) {
    throw new Error(
      `${cell.location} ${cell.year}-${cell.month}: ${cell.minutes} minutes cannot cover ` +
      `${days} days at a minimum of ${MIN_DAILY_MINUTES} minutes each.`
    );
  }

  if (cell.minutes > days * MAX_DAILY_MINUTES) {
    throw new Error(
      `${cell.location} ${cell.year}-${cell.month}: ${cell.minutes} minutes exceeds ` +
      `${days} days x 23:59; a single daily flight cannot represent this total.`
    );
  }

  const rng = makeRng(`${cell.location}|${cell.year}|${cell.month}|${cell.minutes}`);
  const durations = randomDailySplit(cell.minutes, days, rng);

  const flights: GeneratedFlight[] = [];

  for (let day = 1; day <= days; day++) {
    const duration = durations[day - 1];

    const flightDate = utcDate(cell.year, cell.month, day);
    const landingMins = TAKEOFF_HOUR * 60 + TAKEOFF_MINUTE + duration;

    flights.push({
      flightCode: flightCodeFor(cell.location, flightDate, TAKEOFF_HOUR, TAKEOFF_MINUTE),
      enforcementAreaId,
      location: cell.location,
      flightDate,
      takeoffTime: utcTime(TAKEOFF_HOUR, TAKEOFF_MINUTE),
      landingTime: utcTime(Math.floor(landingMins / 60), landingMins % 60),
      durationMinutes: duration,
      remarks: `Backdated entry from flight-time sheet (${cell.raw} for ${cell.year}-${String(cell.month).padStart(2, '0')})`,
      createdBy: CREATED_BY,
    });
  }

  const sum = flights.reduce((t, f) => t + f.durationMinutes, 0);
  if (sum !== cell.minutes) {
    throw new Error(`${cell.location} ${cell.year}-${cell.month}: generated ${sum} minutes, expected ${cell.minutes}`);
  }

  return flights;
}

/**
 * Resolve the enforcement area for a district.
 *
 * enforcement_areas contains case-duplicate rows ("Palghar" and "PALGHAR").
 * Attaching new flights to the wrong one would split a district's totals in
 * the dashboard, so prefer the row that this location's EXISTING flights
 * already use. Only fall back to name matching when the location is new.
 */
async function resolveEnforcementAreaId(
  district: string,
  location: string,
  areasByLowerName: Map<string, Array<{ id: string; name: string }>>
): Promise<{ id: string; how: string; warning?: string }> {
  const existing = await prisma.flight.groupBy({
    by: ['enforcementAreaId'],
    where: { location },
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
  });

  if (existing.length > 0) {
    const id = existing[0].enforcementAreaId;
    const warning = existing.length > 1
      ? `location "${location}" already spans ${existing.length} enforcement areas; using the most-used one`
      : undefined;
    return { id, how: 'matched existing flights at this location', warning };
  }

  const candidates = areasByLowerName.get(district.toLowerCase().trim()) || [];
  if (candidates.length === 0) {
    throw new Error(`No enforcement area found for district "${district}" (location "${location}")`);
  }

  // Deterministic choice: exact name match first, then lowest id.
  const exact = candidates.find(c => c.name === district);
  const chosen = exact || [...candidates].sort((a, b) => a.id.localeCompare(b.id))[0];

  const warning = candidates.length > 1
    ? `district "${district}" has ${candidates.length} enforcement-area rows (${candidates.map(c => c.name).join(', ')}); chose "${chosen.name}"`
    : undefined;

  return { id: chosen.id, how: 'matched enforcement area by name', warning };
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const argv = process.argv.slice(2);
  const commit = argv.includes('--commit');
  const force = argv.includes('--force');
  const locationFilter = argv.find(a => a.startsWith('--location='))?.split('=')[1];
  const monthFilter = argv.find(a => a.startsWith('--month='))?.split('=')[1];

  const line = '='.repeat(72);
  console.log(line);
  console.log('Backdated Flight Entries - Aug / Sep / Oct 2026');
  console.log(line);
  console.log(commit ? 'MODE: COMMIT (will write to the database)' : 'MODE: DRY RUN (no changes - pass --commit to write)');
  if (force) console.log('FORCE: on - months that already hold flights will be filled anyway');
  console.log(`Target database: ${(process.env.DATABASE_URL || '').replace(/:\/\/[^@]*@/, '://****@') || '(DATABASE_URL not set)'}`);
  console.log('');

  // ---- integrity of the embedded table -------------------------------------
  const tableTotal = SOURCE_DATA.reduce((t, c) => t + c.minutes, 0);
  if (SOURCE_DATA.length !== EXPECTED_CELLS || tableTotal !== EXPECTED_TOTAL_MINUTES) {
    throw new Error(
      `Source table integrity check failed: ${SOURCE_DATA.length} cells / ${tableTotal} minutes, ` +
      `expected ${EXPECTED_CELLS} / ${EXPECTED_TOTAL_MINUTES}`
    );
  }
  console.log(`Source table OK: ${SOURCE_DATA.length} cells, ${formatMinutes(tableTotal)} total`);

  let cells = SOURCE_DATA;
  if (locationFilter) cells = cells.filter(c => c.location.toLowerCase() === locationFilter.toLowerCase());
  if (monthFilter) cells = cells.filter(c => String(c.month) === monthFilter);
  if (cells.length !== SOURCE_DATA.length) {
    console.log(`Filtered to ${cells.length} cell(s)`);
  }
  if (cells.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // ---- enforcement areas ---------------------------------------------------
  const areas = await prisma.enforcementArea.findMany({ select: { id: true, name: true } });
  const areasByLowerName = new Map<string, Array<{ id: string; name: string }>>();
  for (const a of areas) {
    const key = a.name.toLowerCase().trim();
    if (!areasByLowerName.has(key)) areasByLowerName.set(key, []);
    areasByLowerName.get(key)!.push(a);
  }

  // ---- plan ----------------------------------------------------------------
  const warnings: string[] = [];
  const toInsert: GeneratedFlight[] = [];
  const skipped: string[] = [];

  console.log('');
  console.log('Plan:');
  console.log('  Sr  Location      Month     Sheet        Existing  Action');
  console.log('  ' + '-'.repeat(66));

  for (const cell of cells) {
    const label = `${cell.year}-${String(cell.month).padStart(2, '0')}`;

    const monthStart = utcDate(cell.year, cell.month, 1);
    const monthEnd = utcDate(cell.year, cell.month, daysInMonth(cell.year, cell.month));

    const existing = await prisma.flight.aggregate({
      where: { location: cell.location, flightDate: { gte: monthStart, lte: monthEnd } },
      _count: { id: true },
      _sum: { durationMinutes: true },
    });

    const existingCount = existing._count.id;

    if (existingCount > 0 && !force) {
      skipped.push(`${cell.location} ${label} (${existingCount} flights, ${formatMinutes(existing._sum.durationMinutes || 0)} already present)`);
      console.log(
        `  ${String(cell.sr).padStart(2)}  ${cell.location.padEnd(13)} ${label}  ${cell.raw.padEnd(11)} ` +
        `${String(existingCount).padStart(8)}  SKIP (already has data)`
      );
      continue;
    }

    const resolved = await resolveEnforcementAreaId(cell.district, cell.location, areasByLowerName);
    if (resolved.warning) warnings.push(resolved.warning);

    const flights = generateFlights(cell, resolved.id);
    toInsert.push(...flights);

    console.log(
      `  ${String(cell.sr).padStart(2)}  ${cell.location.padEnd(13)} ${label}  ${cell.raw.padEnd(11)} ` +
      `${String(existingCount).padStart(8)}  ADD ${flights.length} flights (${formatMinutes(cell.minutes)})`
    );
  }

  // ---- pre-flight checks ---------------------------------------------------
  console.log('');

  const codes = toInsert.map(f => f.flightCode);
  const dupInBatch = codes.filter((c, i) => codes.indexOf(c) !== i);
  if (dupInBatch.length > 0) {
    throw new Error(`Generated duplicate flight codes within the batch: ${[...new Set(dupInBatch)].slice(0, 5).join(', ')}`);
  }

  const clashes = codes.length
    ? await prisma.flight.findMany({ where: { flightCode: { in: codes } }, select: { flightCode: true } })
    : [];
  if (clashes.length > 0) {
    console.log(`NOTE: ${clashes.length} generated flight code(s) already exist in the database.`);
    console.log('      These are almost certainly from a previous run of this script and will be skipped.');
    console.log(`      Example: ${clashes.slice(0, 3).map(c => c.flightCode).join(', ')}`);
  }

  if (warnings.length > 0) {
    console.log('');
    console.log('Warnings:');
    for (const w of [...new Set(warnings)]) console.log(`  - ${w}`);
  }

  if (skipped.length > 0) {
    console.log('');
    console.log(`Skipped ${skipped.length} month(s) that already hold flights (use --force to add anyway):`);
    for (const s of skipped) console.log(`  - ${s}`);
  }

  const insertMinutes = toInsert.reduce((t, f) => t + f.durationMinutes, 0);
  console.log('');
  console.log(`Ready to insert: ${toInsert.length} flights, ${formatMinutes(insertMinutes)}`);

  if (toInsert.length === 0) {
    console.log('Nothing to insert. Done.');
    return;
  }

  if (!commit) {
    console.log('');
    console.log('DRY RUN - nothing written. Re-run with --commit to apply.');
    return;
  }

  // ---- write ---------------------------------------------------------------
  console.log('');
  console.log('Writing (single transaction, insert-only)...');

  const before = await prisma.flight.count();

  let created = 0;
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const batchSize = 500;
    for (let i = 0; i < toInsert.length; i += batchSize) {
      const batch = toInsert.slice(i, i + batchSize);
      const res = await tx.flight.createMany({ data: batch, skipDuplicates: true });
      created += res.count;
      process.stdout.write(`\r  inserted ${created} / ${toInsert.length}`);
    }
  }, { timeout: 120_000 });

  const after = await prisma.flight.count();
  console.log('');
  console.log(`  rows before: ${before}   after: ${after}   created: ${created}`);

  // ---- verify --------------------------------------------------------------
  console.log('');
  console.log('Verification (sheet value vs stored total, this script\'s rows only):');
  let allMatch = true;

  for (const cell of cells) {
    const monthStart = utcDate(cell.year, cell.month, 1);
    const monthEnd = utcDate(cell.year, cell.month, daysInMonth(cell.year, cell.month));

    const got = await prisma.flight.aggregate({
      where: {
        location: cell.location,
        createdBy: CREATED_BY,
        flightDate: { gte: monthStart, lte: monthEnd },
      },
      _count: { id: true },
      _sum: { durationMinutes: true },
    });

    const stored = got._sum.durationMinutes || 0;
    const label = `${cell.year}-${String(cell.month).padStart(2, '0')}`;

    if (got._count.id === 0) {
      console.log(`  ${cell.location.padEnd(13)} ${label}  skipped (not written by this script)`);
      continue;
    }

    const ok = stored === cell.minutes;
    if (!ok) allMatch = false;
    console.log(
      `  ${cell.location.padEnd(13)} ${label}  sheet ${formatMinutes(cell.minutes).padEnd(10)} ` +
      `stored ${formatMinutes(stored).padEnd(10)} ${ok ? 'OK' : 'MISMATCH'}`
    );
  }

  console.log('');
  console.log(line);
  console.log(allMatch ? 'Completed - all written months match the sheet exactly.' : 'Completed WITH MISMATCHES - review the table above.');
  console.log(`Rows are tagged createdBy = '${CREATED_BY}'`);
  console.log('To undo this run (and only this run):');
  console.log(`  DELETE FROM flights WHERE created_by = '${CREATED_BY}';`);
  console.log(line);

  if (!allMatch) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('');
    console.error('FAILED:', err instanceof Error ? err.message : err);
    console.error('No partial data was written - the insert runs in a transaction.');
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
