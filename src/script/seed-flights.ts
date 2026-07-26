/**
 * Flight Data Seed Script
 *
 * Reads flight hours from Excel file and generates random flight records
 * that match the monthly totals per district/location.
 *
 * Usage: npm run db:seed:flights
 */

import { PrismaClient } from '@prisma/client';
import * as XLSX from 'xlsx';
import * as path from 'path';

const prisma = new PrismaClient();

// =============================================================================
// INTERFACES
// =============================================================================

interface MonthData {
  year: number;
  month: number; // 0-indexed (0 = January)
  totalMinutes: number;
}

interface LocationData {
  district: string;
  location: string;
  monthlyData: MonthData[];
}

interface FlightRecord {
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

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Parse time string "HH:MM:SS" or " HH:MM:SS" to total minutes
 */
function parseTimeToMinutes(timeStr: string | number | undefined | null): number {
  if (timeStr === undefined || timeStr === null || timeStr === '') {
    return 0;
  }

  if (typeof timeStr === 'number') {
    // Already converted to decimal hours by Excel
    return Math.round(timeStr * 60);
  }

  const cleaned = String(timeStr).trim();
  if (!cleaned) return 0;

  const parts = cleaned.split(':');

  if (parts.length >= 2) {
    const hours = parseInt(parts[0], 10) || 0;
    const minutes = parseInt(parts[1], 10) || 0;
    return hours * 60 + minutes;
  }

  return 0;
}

/**
 * Convert Excel serial date to year-month
 */
function excelSerialToYearMonth(serial: number): { year: number; month: number } {
  // Excel serial date starts from 1900-01-01 (serial = 1)
  // But Excel has a bug where it thinks 1900 was a leap year
  const excelEpoch = new Date(1899, 11, 30); // Dec 30, 1899
  const date = new Date(excelEpoch.getTime() + serial * 24 * 60 * 60 * 1000);
  return {
    year: date.getFullYear(),
    month: date.getMonth(), // 0-indexed
  };
}

/**
 * Get number of days in a month
 */
function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * Generate a random integer between min and max (inclusive)
 */
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate a random time between 9:00 and 14:00 (to allow 2hr flights ending by 16:00)
 */
function generateRandomTakeoffTime(): { hours: number; minutes: number } {
  const hours = randomInt(9, 14);
  const minutes = randomInt(0, 59);
  return { hours, minutes };
}

/**
 * Generate flight code: LOCATION-YYYYMMDD-HHMM
 */
function generateFlightCode(location: string, date: Date, takeoffHours: number, takeoffMinutes: number): string {
  const locationCode = location
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .substring(0, 10);

  const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');
  const timeStr = `${takeoffHours.toString().padStart(2, '0')}${takeoffMinutes.toString().padStart(2, '0')}`;

  return `${locationCode}-${dateStr}-${timeStr}`;
}

/**
 * Create a Date object for time storage (using 1970-01-01 as base)
 */
function createTimeDate(hours: number, minutes: number): Date {
  return new Date(1970, 0, 1, hours, minutes, 0);
}

/**
 * Distribute total minutes across days in a month, creating random flights
 * ENSURES EXACT MATCH of total minutes
 */
function generateFlightsForMonth(
  location: string,
  enforcementAreaId: string,
  year: number,
  month: number,
  totalMinutes: number
): FlightRecord[] {
  const flights: FlightRecord[] = [];
  const daysInMonth = getDaysInMonth(year, month);

  if (totalMinutes <= 0) {
    return flights;
  }

  let remainingMinutes = totalMinutes;

  // Use all days of the month if needed
  const allDays = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  // Keep generating flights until we've used all minutes
  let dayIndex = 0;
  let flightCounter = 0;

  while (remainingMinutes > 0) {
    const day = allDays[dayIndex % daysInMonth];
    const flightDate = new Date(year, month, day);

    // Generate 3-5 flights per day visit
    const flightsThisVisit = randomInt(3, 5);

    for (let f = 0; f < flightsThisVisit && remainingMinutes > 0; f++) {
      // Random takeoff time between 9:00 and 14:00
      const takeoffHour = randomInt(9, 14);
      const takeoffMinute = randomInt(0, 59);

      // Duration: aim for 90-150 mins, but take what's remaining if less
      let duration: number;
      if (remainingMinutes <= 150) {
        duration = remainingMinutes; // Take exactly what's left
      } else if (remainingMinutes <= 300) {
        // Split remaining into reasonable chunks
        duration = Math.min(randomInt(90, 150), remainingMinutes);
      } else {
        duration = randomInt(90, 150);
      }

      // Calculate landing time
      const totalTakeoffMins = takeoffHour * 60 + takeoffMinute;
      const totalLandingMins = totalTakeoffMins + duration;
      const landingHour = Math.floor(totalLandingMins / 60);
      const landingMinute = totalLandingMins % 60;

      flightCounter++;

      flights.push({
        flightCode: generateFlightCode(location, flightDate, takeoffHour, takeoffMinute) + `-${flightCounter}`,
        enforcementAreaId,
        location,
        flightDate,
        takeoffTime: createTimeDate(takeoffHour, takeoffMinute),
        landingTime: createTimeDate(landingHour, landingMinute),
        durationMinutes: duration,
        remarks: `Seeded flight data for ${location}`,
        createdBy: 'seed-script',
      });

      remainingMinutes -= duration;
    }

    dayIndex++;

    // Safety: prevent infinite loop (max 500 flights per month per location)
    if (flightCounter > 500) {
      // If we still have remaining minutes, add them to the last flight
      if (remainingMinutes > 0 && flights.length > 0) {
        const lastFlight = flights[flights.length - 1];
        lastFlight.durationMinutes += remainingMinutes;

        // Recalculate landing time
        const takeoffMins = lastFlight.takeoffTime.getHours() * 60 + lastFlight.takeoffTime.getMinutes();
        const landingMins = takeoffMins + lastFlight.durationMinutes;
        lastFlight.landingTime = createTimeDate(Math.floor(landingMins / 60), landingMins % 60);

        remainingMinutes = 0;
      }
      break;
    }
  }

  return flights;
}

// =============================================================================
// MAIN SEED FUNCTION
// =============================================================================

async function seedFlights() {
  console.log('='.repeat(60));
  console.log('Flight Data Seed Script');
  console.log('='.repeat(60));

  try {
    // Read Excel file
    const excelPath = path.resolve(__dirname, '../../../Fight time Dashboard.xlsx');
    console.log(`\nReading Excel file: ${excelPath}`);

    const workbook = XLSX.readFile(excelPath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false }) as any[][];

    // Parse month columns from row 1 (Excel serial dates)
    const rawRow1 = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];
    const monthSerials = rawRow1[0].slice(3) as number[];

    const months = monthSerials.map(serial => excelSerialToYearMonth(serial));
    console.log(`\nFound ${months.length} months of data:`);
    console.log(`  From: ${months[0].year}-${(months[0].month + 1).toString().padStart(2, '0')}`);
    console.log(`  To:   ${months[months.length - 1].year}-${(months[months.length - 1].month + 1).toString().padStart(2, '0')}`);

    // Parse location data from rows 3 onwards
    const locationData: LocationData[] = [];

    for (let i = 2; i < data.length; i++) {
      const row = data[i];
      if (!row || !row[1] || !row[2]) continue;

      const district = String(row[1]).trim();
      const location = String(row[2]).trim();

      const monthlyData: MonthData[] = [];

      for (let j = 0; j < months.length; j++) {
        const cellValue = row[3 + j];
        const totalMinutes = parseTimeToMinutes(cellValue);

        monthlyData.push({
          year: months[j].year,
          month: months[j].month,
          totalMinutes,
        });
      }

      locationData.push({ district, location, monthlyData });
    }

    console.log(`\nFound ${locationData.length} locations across districts:`);
    const districtCounts = locationData.reduce((acc, loc) => {
      acc[loc.district] = (acc[loc.district] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    Object.entries(districtCounts).forEach(([district, count]) => {
      console.log(`  ${district}: ${count} locations`);
    });

    // Get enforcement area IDs for each district
    console.log('\nFetching enforcement area IDs...');
    const enforcementAreas = await prisma.enforcementArea.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
    });

    const districtToId = new Map<string, string>();
    for (const ea of enforcementAreas) {
      // Match by name (case-insensitive)
      const normalizedName = ea.name.toLowerCase().trim();
      districtToId.set(normalizedName, ea.id);
    }

    console.log(`Found ${enforcementAreas.length} enforcement areas`);

    // Clear existing seeded flights
    console.log('\nClearing existing seeded flights...');
    const deleted = await prisma.flight.deleteMany({
      where: { createdBy: 'seed-script' },
    });
    console.log(`Deleted ${deleted.count} existing seeded flights`);

    // Generate flights for each location/month
    console.log('\nGenerating flight records...');
    const allFlights: FlightRecord[] = [];
    let skippedLocations = 0;

    for (const loc of locationData) {
      const districtKey = loc.district.toLowerCase().trim();
      const enforcementAreaId = districtToId.get(districtKey);

      if (!enforcementAreaId) {
        console.warn(`  Warning: No enforcement area found for district "${loc.district}"`);
        skippedLocations++;
        continue;
      }

      for (const monthData of loc.monthlyData) {
        if (monthData.totalMinutes <= 0) continue;

        const flights = generateFlightsForMonth(
          loc.location,
          enforcementAreaId,
          monthData.year,
          monthData.month,
          monthData.totalMinutes
        );

        allFlights.push(...flights);
      }
    }

    console.log(`\nGenerated ${allFlights.length} flight records`);
    if (skippedLocations > 0) {
      console.log(`Skipped ${skippedLocations} locations due to missing enforcement areas`);
    }

    // Calculate totals for verification
    const totalMinutes = allFlights.reduce((sum, f) => sum + f.durationMinutes, 0);
    const totalHours = Math.round(totalMinutes / 60);
    console.log(`Total flying time: ${totalHours} hours (${totalMinutes} minutes)`);

    // Insert flights in batches
    console.log('\nInserting flights into database...');
    const batchSize = 500;
    let inserted = 0;

    for (let i = 0; i < allFlights.length; i += batchSize) {
      const batch = allFlights.slice(i, i + batchSize);

      await prisma.flight.createMany({
        data: batch,
        skipDuplicates: true,
      });

      inserted += batch.length;
      process.stdout.write(`\r  Progress: ${inserted}/${allFlights.length} flights`);
    }

    console.log('\n');

    // Verify by district
    console.log('Verification by district:');
    const flightsByDistrict = await prisma.flight.groupBy({
      by: ['enforcementAreaId'],
      where: { createdBy: 'seed-script' },
      _count: { id: true },
      _sum: { durationMinutes: true },
    });

    for (const stat of flightsByDistrict) {
      const ea = enforcementAreas.find(e => e.id === stat.enforcementAreaId);
      const hours = Math.round((stat._sum.durationMinutes || 0) / 60);
      console.log(`  ${ea?.name || 'Unknown'}: ${stat._count.id} flights, ${hours} hours`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('Flight seed completed successfully!');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\nError seeding flights:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the seed
seedFlights()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
