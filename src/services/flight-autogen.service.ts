/**
 * Flight Auto-Generation Service
 *
 * Generates a set of flights for a district/site over a date range so that the
 * durations add up EXACTLY to a target total. Timing patterns (first takeoff
 * window, gap between sorties, latest landing, day-to-day variation) are learned
 * from existing flight history when it is varied enough, otherwise sensible
 * operational defaults are used.
 *
 * Two-phase flow:
 *   1. preview()  - pure generation + list of existing flights that would be overwritten
 *   2. commit()   - in one transaction: delete the district's flights on those days,
 *                   then create exactly the flights the user saw in the preview
 */

import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { generateFlightCode, parseTimeToDate, formatTimeFromDate } from './flights.service';

// =============================================================================
// CONSTANTS
// =============================================================================

export const AUTOGEN_LIMITS = {
  maxDays: 366,
  maxFlightsPerDay: 10,
  minFlightMinutes: 5,
  /** Earliest allowed takeoff (05:00) */
  dayStart: 5 * 60,
  /** Latest allowed landing (23:50) - generated flights never cross midnight */
  dayEnd: 23 * 60 + 50,
  /** Minimum gap between two sorties on the same day */
  minGap: 5,
};

const DEFAULT_PROFILE = {
  startWindow: [6 * 60 + 30, 9 * 60 + 30] as [number, number], // first takeoff 06:30–09:30
  gapRange: [15, 45] as [number, number], // battery swap / repositioning
  preferredEnd: 19 * 60, // try to land by 19:00
  dailyJitter: 0.2, // ±20% day-to-day variation in flying time
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

// =============================================================================
// TYPES
// =============================================================================

export interface AutoGenInput {
  enforcementAreaId: string;
  location: string;
  startDate: string; // yyyy-MM-dd
  endDate: string; // yyyy-MM-dd
  totalMinutes: number;
  flightsPerDay: number;
}

export interface GeneratedFlight {
  flightDate: string; // yyyy-MM-dd
  takeoffTime: string; // HH:mm
  landingTime: string; // HH:mm
  durationMinutes: number;
}

export interface ExistingFlightSummary {
  id: string;
  flightCode: string;
  location: string;
  takeoffTime: string;
  landingTime: string;
  durationMinutes: number;
}

export interface PreviewDay {
  date: string;
  totalMinutes: number;
  flights: GeneratedFlight[];
  existing: ExistingFlightSummary[];
}

export interface TimingProfile {
  source: 'history' | 'default';
  sampleDays: number;
  startWindow: [number, number];
  gapRange: [number, number];
  preferredEnd: number;
  dailyJitter: number;
}

export interface CommitInput {
  enforcementAreaId: string;
  location: string;
  startDate: string;
  endDate: string;
  remarks?: string;
  flights: { flightDate: string; takeoffTime: string; landingTime: string }[];
}

/** Error whose message is safe to show to the user (mapped to HTTP 400) */
export class AutoGenValidationError extends Error {}

// =============================================================================
// SMALL HELPERS
// =============================================================================

const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const toHHmm = (m: number) =>
  `${Math.floor(m / 60).toString().padStart(2, '0')}:${(m % 60).toString().padStart(2, '0')}`;
const fromHHmm = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = clamp(Math.round((sorted.length - 1) * p), 0, sorted.length - 1);
  return sorted[idx];
}

/** All dates from start to end inclusive, as yyyy-MM-dd (UTC arithmetic, no TZ drift) */
function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  let t = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  while (t <= e) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

/** Stored @db.Date value -> yyyy-MM-dd (Prisma returns UTC midnight) */
const dateKey = (d: Date) => d.toISOString().slice(0, 10);

/** yyyy-MM-dd -> Date at UTC midnight (same convention the manual create endpoint uses) */
const toDbDate = (s: string) => new Date(`${s}T00:00:00Z`);

/**
 * Split `total` into `n` integers that sum to exactly `total`, each within [min, max],
 * with random variation of ±jitter around the mean.
 * Precondition: n*min <= total <= n*max.
 */
function splitTotal(total: number, n: number, jitter: number, min: number, max: number): number[] {
  const weights = Array.from({ length: n }, () => 1 + (Math.random() * 2 - 1) * jitter);
  const wsum = sum(weights);
  const raw = weights.map((w) => (total * w) / wsum);

  // Floor, then hand out the remainder by largest fractional part (keeps the sum exact)
  const parts = raw.map(Math.floor);
  let rem = total - sum(parts);
  const order = raw
    .map((r, i) => [r - Math.floor(r), i] as const)
    .sort((a, b) => b[0] - a[0])
    .map(([, i]) => i);
  for (let k = 0; rem > 0; k++, rem--) parts[order[k % n]]++;

  // Clamp into [min, max] and push the difference onto parts that still have room
  let excess = 0;
  for (let i = 0; i < n; i++) {
    if (parts[i] > max) {
      excess += parts[i] - max;
      parts[i] = max;
    } else if (parts[i] < min) {
      excess -= min - parts[i];
      parts[i] = min;
    }
  }
  for (const i of shuffle([...Array(n).keys()])) {
    if (excess === 0) break;
    if (excess > 0) {
      const t = Math.min(max - parts[i], excess);
      parts[i] += t;
      excess -= t;
    } else {
      const t = Math.min(parts[i] - min, -excess);
      parts[i] -= t;
      excess += t;
    }
  }
  return parts;
}

/** Max flying minutes that fit in one day with k sorties */
const maxDayMinutes = (k: number) =>
  AUTOGEN_LIMITS.dayEnd - AUTOGEN_LIMITS.dayStart - (k - 1) * AUTOGEN_LIMITS.minGap;

/**
 * Lay out sorties of the given durations within one day, back-to-back with gaps.
 * Returns [takeoff, landing] in minutes-of-day.
 */
function scheduleDay(durations: number[], profile: TimingProfile): [number, number][] {
  const { dayStart, dayEnd, minGap } = AUTOGEN_LIMITS;
  const busy = sum(durations);
  let gaps = durations.slice(1).map(() => randInt(profile.gapRange[0], profile.gapRange[1]));
  let start = randInt(profile.startWindow[0], profile.startWindow[1]);
  const span = () => busy + sum(gaps);

  // 1. Running past the preferred end: start earlier (not before dayStart)
  if (start + span() > profile.preferredEnd) {
    start = Math.max(dayStart, profile.preferredEnd - span());
  }
  // 2. Still past preferred end: tighten gaps to the minimum
  if (start + span() > profile.preferredEnd) {
    gaps = gaps.map(() => minGap);
    start = Math.max(dayStart, Math.min(start, profile.preferredEnd - span()));
  }
  // 3. Hard limit - guaranteed to fit by maxDayMinutes() caps, this is a safety net
  if (start + span() > dayEnd) {
    start = Math.max(dayStart, dayEnd - span());
  }
  if (start + span() > dayEnd) {
    throw new AutoGenValidationError('Daily flying time does not fit within a single day');
  }

  const out: [number, number][] = [];
  let t = start;
  durations.forEach((d, i) => {
    out.push([t, t + d]);
    t += d + (gaps[i] ?? 0);
  });
  return out;
}

// =============================================================================
// SERVICE
// =============================================================================

class FlightAutoGenService {
  /**
   * Learn timing patterns from existing flights.
   * Uses the district's history first, then all districts. History is only trusted
   * when it is varied (placeholder/backdated rows often all share one takeoff time).
   */
  async buildProfile(enforcementAreaId: string): Promise<TimingProfile> {
    const fromRows = (rows: { flightDate: Date; takeoffTime: Date; landingTime: Date }[]) => {
      const byDay = new Map<string, [number, number][]>();
      for (const r of rows) {
        const t = fromHHmm(formatTimeFromDate(r.takeoffTime));
        const l = fromHHmm(formatTimeFromDate(r.landingTime));
        if (l <= t) continue; // skip overnight / malformed rows
        const k = dateKey(r.flightDate);
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k)!.push([t, l]);
      }

      const firstTakeoffs: number[] = [];
      const lastLandings: number[] = [];
      const gaps: number[] = [];
      const dailyTotals: number[] = [];
      for (const sorties of byDay.values()) {
        sorties.sort((a, b) => a[0] - b[0]);
        firstTakeoffs.push(sorties[0][0]);
        lastLandings.push(Math.max(...sorties.map((s) => s[1])));
        dailyTotals.push(sum(sorties.map(([t, l]) => l - t)));
        for (let i = 1; i < sorties.length; i++) {
          const g = sorties[i][0] - sorties[i - 1][1];
          if (g > 0) gaps.push(g);
        }
      }
      return { days: byDay.size, firstTakeoffs, lastLandings, gaps, dailyTotals };
    };

    const select = { flightDate: true, takeoffTime: true, landingTime: true } as const;
    let stats = fromRows(
      await prisma.flight.findMany({ where: { enforcementAreaId }, select, orderBy: { flightDate: 'desc' }, take: 3000 })
    );
    if (stats.days < 5) {
      stats = fromRows(await prisma.flight.findMany({ select, orderBy: { flightDate: 'desc' }, take: 3000 }));
    }

    const profile: TimingProfile = {
      source: 'default',
      sampleDays: stats.days,
      startWindow: [...DEFAULT_PROFILE.startWindow],
      gapRange: [...DEFAULT_PROFILE.gapRange],
      preferredEnd: DEFAULT_PROFILE.preferredEnd,
      dailyJitter: DEFAULT_PROFILE.dailyJitter,
    };

    // First-takeoff window: needs at least 5 days and 5 distinct start times
    const starts = [...stats.firstTakeoffs].sort((a, b) => a - b);
    if (starts.length >= 5 && new Set(starts).size >= 5) {
      let lo = clamp(percentile(starts, 0.1), AUTOGEN_LIMITS.dayStart, 12 * 60);
      let hi = clamp(percentile(starts, 0.9), AUTOGEN_LIMITS.dayStart, 12 * 60);
      if (hi - lo < 30) {
        lo = clamp(lo - 15, AUTOGEN_LIMITS.dayStart, 12 * 60);
        hi = clamp(lo + 30, AUTOGEN_LIMITS.dayStart, 12 * 60);
      }
      profile.startWindow = [lo, hi];
      profile.source = 'history';

      const ends = [...stats.lastLandings].sort((a, b) => a - b);
      profile.preferredEnd = clamp(percentile(ends, 0.9), 15 * 60, 21 * 60);
    }

    // Gap between sorties
    const gaps = [...stats.gaps].sort((a, b) => a - b);
    if (gaps.length >= 5 && new Set(gaps).size >= 3) {
      const lo = clamp(percentile(gaps, 0.25), AUTOGEN_LIMITS.minGap, 90);
      const hi = clamp(percentile(gaps, 0.75), lo, 120);
      profile.gapRange = [lo, hi];
      profile.source = 'history';
    }

    // Day-to-day variation (coefficient of variation of daily flying time)
    if (stats.dailyTotals.length >= 5) {
      const mean = sum(stats.dailyTotals) / stats.dailyTotals.length;
      const sd = Math.sqrt(sum(stats.dailyTotals.map((x) => (x - mean) ** 2)) / stats.dailyTotals.length);
      if (mean > 0) profile.dailyJitter = clamp(sd / mean, 0.1, 0.35);
    }

    return profile;
  }

  /** Validate the generation request and return the list of days */
  private async validate(input: AutoGenInput): Promise<string[]> {
    const { enforcementAreaId, location, startDate, endDate, totalMinutes, flightsPerDay } = input;

    if (!enforcementAreaId) throw new AutoGenValidationError('District is required');
    if (!location || !location.trim()) throw new AutoGenValidationError('Site location is required');
    if (location.trim().length > 200) throw new AutoGenValidationError('Site location is too long');
    if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate) || isNaN(Date.parse(startDate)) || isNaN(Date.parse(endDate))) {
      throw new AutoGenValidationError('Invalid date range');
    }
    if (endDate < startDate) throw new AutoGenValidationError('"Date to" must be on or after "Date from"');
    if (!Number.isInteger(flightsPerDay) || flightsPerDay < 1 || flightsPerDay > AUTOGEN_LIMITS.maxFlightsPerDay) {
      throw new AutoGenValidationError(`Flights per day must be between 1 and ${AUTOGEN_LIMITS.maxFlightsPerDay}`);
    }
    if (!Number.isInteger(totalMinutes) || totalMinutes <= 0) {
      throw new AutoGenValidationError('Total hours must be greater than zero');
    }

    const days = eachDay(startDate, endDate);
    if (days.length > AUTOGEN_LIMITS.maxDays) {
      throw new AutoGenValidationError(`Date range cannot exceed ${AUTOGEN_LIMITS.maxDays} days`);
    }

    const totalFlights = days.length * flightsPerDay;
    const minTotal = totalFlights * AUTOGEN_LIMITS.minFlightMinutes;
    if (totalMinutes < minTotal) {
      throw new AutoGenValidationError(
        `Total hours too low: ${totalFlights} flights need at least ${toHHmm(minTotal)} hrs (${AUTOGEN_LIMITS.minFlightMinutes} min each). Reduce flights per day or the date range.`
      );
    }
    const maxTotal = days.length * maxDayMinutes(flightsPerDay);
    if (totalMinutes > maxTotal) {
      throw new AutoGenValidationError(
        `Total hours too high: ${days.length} day(s) can hold at most ${toHHmm(maxTotal)} hrs. Extend the date range.`
      );
    }

    const area = await prisma.enforcementArea.findUnique({ where: { id: enforcementAreaId }, select: { id: true } });
    if (!area) throw new AutoGenValidationError('District not found');

    return days;
  }

  /** Existing flights of the district within the range, grouped by day */
  private async existingByDay(enforcementAreaId: string, startDate: string, endDate: string) {
    const rows = await prisma.flight.findMany({
      where: { enforcementAreaId, flightDate: { gte: toDbDate(startDate), lte: toDbDate(endDate) } },
      orderBy: [{ flightDate: 'asc' }, { takeoffTime: 'asc' }],
    });
    const map = new Map<string, ExistingFlightSummary[]>();
    for (const r of rows) {
      const k = dateKey(r.flightDate);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push({
        id: r.id,
        flightCode: r.flightCode,
        location: r.location,
        takeoffTime: formatTimeFromDate(r.takeoffTime),
        landingTime: formatTimeFromDate(r.landingTime),
        durationMinutes: r.durationMinutes,
      });
    }
    for (const list of map.values()) list.sort((a, b) => a.takeoffTime.localeCompare(b.takeoffTime));
    return map;
  }

  /**
   * Generate a preview. Nothing is written to the database.
   */
  async preview(input: AutoGenInput) {
    const days = await this.validate(input);
    const { flightsPerDay: k, totalMinutes } = input;
    const profile = await this.buildProfile(input.enforcementAreaId);

    // 1. Split the total across days (exact), within per-day feasibility bounds
    const dayMax = maxDayMinutes(k);
    const dayMin = k * AUTOGEN_LIMITS.minFlightMinutes;
    const avgDay = totalMinutes / days.length;
    // Shrink jitter when the average day is close to its limits so clamping stays rare
    const jitter = Math.max(0, Math.min(profile.dailyJitter, dayMax / avgDay - 1, 1 - dayMin / avgDay));
    const perDay = splitTotal(totalMinutes, days.length, jitter, dayMin, dayMax);

    // 2. Split each day into sorties and schedule them
    const existing = await this.existingByDay(input.enforcementAreaId, input.startDate, input.endDate);
    const previewDays: PreviewDay[] = days.map((date, i) => {
      const durations = splitTotal(perDay[i], k, 0.3, AUTOGEN_LIMITS.minFlightMinutes, perDay[i]);
      const slots = scheduleDay(durations, profile);
      return {
        date,
        totalMinutes: perDay[i],
        flights: slots.map(([t, l]) => ({
          flightDate: date,
          takeoffTime: toHHmm(t),
          landingTime: toHHmm(l),
          durationMinutes: l - t,
        })),
        existing: existing.get(date) || [],
      };
    });

    const allExisting = previewDays.flatMap((d) => d.existing);
    const warnings: string[] = [];
    if (avgDay > 12 * 60) {
      warnings.push(`Average of ${toHHmm(Math.round(avgDay))} hrs flying per day is unusually high.`);
    }
    if (avgDay / k > 4 * 60) {
      warnings.push(`Average sortie of ${toHHmm(Math.round(avgDay / k))} hrs is long - consider more flights per day.`);
    }

    return {
      days: previewDays,
      summary: {
        totalDays: days.length,
        totalFlights: days.length * k,
        totalMinutes: sum(previewDays.map((d) => d.totalMinutes)),
        daysWithExisting: previewDays.filter((d) => d.existing.length > 0).length,
        existingFlights: allExisting.length,
        existingMinutes: sum(allExisting.map((f) => f.durationMinutes)),
      },
      profile: {
        source: profile.source,
        sampleDays: profile.sampleDays,
        startWindow: `${toHHmm(profile.startWindow[0])}–${toHHmm(profile.startWindow[1])}`,
        gapRange: `${profile.gapRange[0]}–${profile.gapRange[1]} min`,
        preferredEnd: toHHmm(profile.preferredEnd),
      },
      warnings,
    };
  }

  /**
   * Persist the previewed flights. Atomically deletes ALL flights of the district on
   * the selected days, then creates the given flights.
   */
  async commit(input: CommitInput, createdBy?: string) {
    const { enforcementAreaId, startDate, endDate } = input;
    const location = (input.location || '').trim();

    if (!enforcementAreaId) throw new AutoGenValidationError('District is required');
    if (!location) throw new AutoGenValidationError('Site location is required');
    if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate) || endDate < startDate) {
      throw new AutoGenValidationError('Invalid date range');
    }
    const days = eachDay(startDate, endDate);
    if (days.length > AUTOGEN_LIMITS.maxDays) {
      throw new AutoGenValidationError(`Date range cannot exceed ${AUTOGEN_LIMITS.maxDays} days`);
    }
    if (!Array.isArray(input.flights) || input.flights.length === 0) {
      throw new AutoGenValidationError('No flights to create');
    }
    if (input.flights.length > days.length * AUTOGEN_LIMITS.maxFlightsPerDay) {
      throw new AutoGenValidationError('Too many flights for the selected range');
    }
    for (const f of input.flights) {
      if (!f || !DATE_RE.test(f.flightDate) || f.flightDate < startDate || f.flightDate > endDate) {
        throw new AutoGenValidationError('A flight date is outside the selected range');
      }
      if (!TIME_RE.test(f.takeoffTime) || !TIME_RE.test(f.landingTime)) {
        throw new AutoGenValidationError('Invalid flight time (expected HH:mm)');
      }
      if (fromHHmm(f.landingTime) <= fromHHmm(f.takeoffTime)) {
        throw new AutoGenValidationError('Landing time must be after takeoff time');
      }
      if (fromHHmm(f.landingTime) - fromHHmm(f.takeoffTime) < AUTOGEN_LIMITS.minFlightMinutes) {
        throw new AutoGenValidationError(`Each flight must be at least ${AUTOGEN_LIMITS.minFlightMinutes} minutes`);
      }
    }

    // Flights may have been edited in the preview: enforce per-day limits and no overlaps
    const byDay = new Map<string, [number, number][]>();
    for (const f of input.flights) {
      if (!byDay.has(f.flightDate)) byDay.set(f.flightDate, []);
      byDay.get(f.flightDate)!.push([fromHHmm(f.takeoffTime), fromHHmm(f.landingTime)]);
    }
    for (const [date, sorties] of byDay) {
      if (sorties.length > AUTOGEN_LIMITS.maxFlightsPerDay) {
        throw new AutoGenValidationError(`${date}: more than ${AUTOGEN_LIMITS.maxFlightsPerDay} flights in a day`);
      }
      sorties.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < sorties.length; i++) {
        if (sorties[i][0] < sorties[i - 1][1]) {
          throw new AutoGenValidationError(
            `${date}: flights ${toHHmm(sorties[i - 1][0])}–${toHHmm(sorties[i - 1][1])} and ${toHHmm(sorties[i][0])}–${toHHmm(sorties[i][1])} overlap`
          );
        }
      }
    }

    const area = await prisma.enforcementArea.findUnique({ where: { id: enforcementAreaId }, select: { id: true } });
    if (!area) throw new AutoGenValidationError('District not found');

    const remarks = input.remarks?.trim() || null;

    const result = await prisma.$transaction(
      async (tx) => {
        const deleted = await tx.flight.deleteMany({
          where: { enforcementAreaId, flightDate: { gte: toDbDate(startDate), lte: toDbDate(endDate) } },
        });

        // Flight codes are globally unique; other districts may share the same code
        // (same location prefix/date/time), so add a numeric suffix on collision.
        // Codes embed the flight date, so remaining flights on these dates (other
        // districts) plus exact matches cover every realistic clash.
        const baseCodes = input.flights.map((f) => generateFlightCode(location, toDbDate(f.flightDate), f.takeoffTime));
        const taken = new Set(
          (
            await tx.flight.findMany({
              where: {
                OR: [
                  { flightDate: { gte: toDbDate(startDate), lte: toDbDate(endDate) } },
                  { flightCode: { in: baseCodes } },
                ],
              },
              select: { flightCode: true },
            })
          ).map((r) => r.flightCode)
        );
        const codes = baseCodes.map((base) => {
          let code = base;
          for (let n = 2; taken.has(code); n++) code = `${base}-${n}`;
          taken.add(code);
          return code;
        });

        const created = await tx.flight.createMany({
          data: input.flights.map((f, i) => ({
            flightCode: codes[i],
            enforcementAreaId,
            location,
            flightDate: toDbDate(f.flightDate),
            takeoffTime: parseTimeToDate(f.takeoffTime),
            landingTime: parseTimeToDate(f.landingTime),
            durationMinutes: fromHHmm(f.landingTime) - fromHHmm(f.takeoffTime),
            remarks,
            createdBy,
          })),
        });

        return { deleted: deleted.count, created: created.count };
      },
      { timeout: 60_000, maxWait: 10_000 }
    );

    logger.info(
      `Auto-generated flights for area ${enforcementAreaId} ${startDate}..${endDate}: created ${result.created}, replaced ${result.deleted}`
    );
    return {
      ...result,
      totalMinutes: sum(input.flights.map((f) => fromHHmm(f.landingTime) - fromHHmm(f.takeoffTime))),
    };
  }
}

export const flightAutoGenService = new FlightAutoGenService();
