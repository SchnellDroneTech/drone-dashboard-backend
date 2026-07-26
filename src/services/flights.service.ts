/**
 * Flights Service
 * Handles CRUD operations for drone flight records
 */

import { PrismaClient, Flight } from '@prisma/client';
import { logger } from '../config/logger';

const prisma = new PrismaClient();

// =============================================================================
// INTERFACES
// =============================================================================

export interface CreateFlightInput {
  enforcementAreaId: string;
  location: string;
  flightDate: Date;
  takeoffTime: string; // HH:mm format
  landingTime: string; // HH:mm format
  remarks?: string;
  createdBy?: string;
}

export interface UpdateFlightInput {
  enforcementAreaId?: string;
  location?: string;
  flightDate?: Date;
  takeoffTime?: string;
  landingTime?: string;
  remarks?: string;
}

export interface FlightFilters {
  enforcementAreaId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  search?: string;
  page?: number;
  limit?: number;
}

export interface FlightWithArea extends Flight {
  enforcementArea: {
    id: string;
    name: string;
  };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Generate unique flight code: LOCATION-YYYYMMDD-HHMM
 */
function generateFlightCode(location: string, flightDate: Date, takeoffTime: string): string {
  const locationCode = location
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .substring(0, 10);

  const dateStr = flightDate.toISOString().split('T')[0].replace(/-/g, '');
  const timeStr = takeoffTime.replace(':', '');

  return `${locationCode}-${dateStr}-${timeStr}`;
}

/**
 * Parse time string to Date object for database storage
 */
function parseTimeToDate(timeStr: string): Date {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const date = new Date(1970, 0, 1, hours, minutes, 0);
  return date;
}

/**
 * Calculate duration in minutes between two time strings
 */
function calculateDurationMinutes(takeoffTime: string, landingTime: string): number {
  const [takeoffHours, takeoffMinutes] = takeoffTime.split(':').map(Number);
  const [landingHours, landingMinutes] = landingTime.split(':').map(Number);

  let takeoffTotalMinutes = takeoffHours * 60 + takeoffMinutes;
  let landingTotalMinutes = landingHours * 60 + landingMinutes;

  // Handle case where landing is next day (crosses midnight)
  if (landingTotalMinutes < takeoffTotalMinutes) {
    landingTotalMinutes += 24 * 60;
  }

  return landingTotalMinutes - takeoffTotalMinutes;
}

/**
 * Format time from Date to HH:mm string
 */
function formatTimeFromDate(date: Date): string {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

// =============================================================================
// SERVICE CLASS
// =============================================================================

class FlightsService {
  /**
   * Create a new flight record
   */
  async create(input: CreateFlightInput): Promise<Flight> {
    const flightCode = generateFlightCode(input.location, input.flightDate, input.takeoffTime);
    const durationMinutes = calculateDurationMinutes(input.takeoffTime, input.landingTime);

    const flight = await prisma.flight.create({
      data: {
        flightCode,
        enforcementAreaId: input.enforcementAreaId,
        location: input.location,
        flightDate: input.flightDate,
        takeoffTime: parseTimeToDate(input.takeoffTime),
        landingTime: parseTimeToDate(input.landingTime),
        durationMinutes,
        remarks: input.remarks,
        createdBy: input.createdBy,
      },
      include: {
        enforcementArea: {
          select: { id: true, name: true },
        },
      },
    });

    logger.info(`Flight created: ${flightCode}`);
    return flight;
  }

  /**
   * Get all flights with filters and pagination
   */
  async getAll(filters: FlightFilters): Promise<{
    flights: FlightWithArea[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (filters.enforcementAreaId) {
      where.enforcementAreaId = filters.enforcementAreaId;
    }

    if (filters.dateFrom || filters.dateTo) {
      where.flightDate = {};
      if (filters.dateFrom) {
        where.flightDate.gte = filters.dateFrom;
      }
      if (filters.dateTo) {
        where.flightDate.lte = filters.dateTo;
      }
    }

    if (filters.search) {
      where.OR = [
        { location: { contains: filters.search, mode: 'insensitive' } },
        { flightCode: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    const [flights, total] = await Promise.all([
      prisma.flight.findMany({
        where,
        include: {
          enforcementArea: {
            select: { id: true, name: true },
          },
        },
        orderBy: [
          { flightDate: 'desc' },
          { takeoffTime: 'desc' },
        ],
        skip,
        take: limit,
      }),
      prisma.flight.count({ where }),
    ]);

    return {
      flights: flights as FlightWithArea[],
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get a single flight by ID
   */
  async getById(id: string): Promise<FlightWithArea | null> {
    const flight = await prisma.flight.findUnique({
      where: { id },
      include: {
        enforcementArea: {
          select: { id: true, name: true },
        },
      },
    });

    return flight as FlightWithArea | null;
  }

  /**
   * Update a flight record
   */
  async update(id: string, input: UpdateFlightInput): Promise<Flight> {
    const existingFlight = await prisma.flight.findUnique({ where: { id } });
    if (!existingFlight) {
      throw new Error('Flight not found');
    }

    const updateData: any = {};

    if (input.enforcementAreaId) {
      updateData.enforcementAreaId = input.enforcementAreaId;
    }

    if (input.location) {
      updateData.location = input.location;
    }

    if (input.flightDate) {
      updateData.flightDate = input.flightDate;
    }

    if (input.takeoffTime) {
      updateData.takeoffTime = parseTimeToDate(input.takeoffTime);
    }

    if (input.landingTime) {
      updateData.landingTime = parseTimeToDate(input.landingTime);
    }

    if (input.remarks !== undefined) {
      updateData.remarks = input.remarks;
    }

    // Recalculate duration if times changed
    const takeoffTime = input.takeoffTime || formatTimeFromDate(existingFlight.takeoffTime);
    const landingTime = input.landingTime || formatTimeFromDate(existingFlight.landingTime);
    updateData.durationMinutes = calculateDurationMinutes(takeoffTime, landingTime);

    // Regenerate flight code if location, date, or takeoff time changed
    if (input.location || input.flightDate || input.takeoffTime) {
      const location = input.location || existingFlight.location;
      const flightDate = input.flightDate || existingFlight.flightDate;
      const takeoff = input.takeoffTime || formatTimeFromDate(existingFlight.takeoffTime);
      updateData.flightCode = generateFlightCode(location, flightDate, takeoff);
    }

    const flight = await prisma.flight.update({
      where: { id },
      data: updateData,
      include: {
        enforcementArea: {
          select: { id: true, name: true },
        },
      },
    });

    logger.info(`Flight updated: ${flight.flightCode}`);
    return flight;
  }

  /**
   * Delete a flight record
   */
  async delete(id: string): Promise<void> {
    const flight = await prisma.flight.findUnique({ where: { id } });
    if (!flight) {
      throw new Error('Flight not found');
    }

    await prisma.flight.delete({ where: { id } });
    logger.info(`Flight deleted: ${flight.flightCode}`);
  }

  /**
   * Get flight statistics
   */
  async getStats(filters?: { enforcementAreaId?: string; dateFrom?: Date; dateTo?: Date }): Promise<{
    totalFlights: number;
    totalDurationMinutes: number;
    avgDurationMinutes: number;
    flightsByDistrict: { district: string; count: number; durationMinutes: number }[];
  }> {
    const where: any = {};

    if (filters?.enforcementAreaId) {
      where.enforcementAreaId = filters.enforcementAreaId;
    }

    if (filters?.dateFrom || filters?.dateTo) {
      where.flightDate = {};
      if (filters.dateFrom) {
        where.flightDate.gte = filters.dateFrom;
      }
      if (filters.dateTo) {
        where.flightDate.lte = filters.dateTo;
      }
    }

    const [stats, flightsByDistrict] = await Promise.all([
      prisma.flight.aggregate({
        where,
        _count: { id: true },
        _sum: { durationMinutes: true },
        _avg: { durationMinutes: true },
      }),
      prisma.flight.groupBy({
        by: ['enforcementAreaId'],
        where,
        _count: { id: true },
        _sum: { durationMinutes: true },
      }),
    ]);

    // Get district names
    const districtIds = flightsByDistrict.map(f => f.enforcementAreaId);
    const districts = await prisma.enforcementArea.findMany({
      where: { id: { in: districtIds } },
      select: { id: true, name: true },
    });

    const districtMap = new Map(districts.map(d => [d.id, d.name]));

    return {
      totalFlights: stats._count.id,
      totalDurationMinutes: stats._sum.durationMinutes || 0,
      avgDurationMinutes: Math.round(stats._avg.durationMinutes || 0),
      flightsByDistrict: flightsByDistrict.map(f => ({
        district: districtMap.get(f.enforcementAreaId) || 'Unknown',
        count: f._count.id,
        durationMinutes: f._sum.durationMinutes || 0,
      })).sort((a, b) => b.count - a.count),
    };
  }

  /**
   * Export all flights for Excel download
   */
  async getAllForExport(filters?: { enforcementAreaId?: string; dateFrom?: Date; dateTo?: Date }): Promise<FlightWithArea[]> {
    const where: any = {};

    if (filters?.enforcementAreaId) {
      where.enforcementAreaId = filters.enforcementAreaId;
    }

    if (filters?.dateFrom || filters?.dateTo) {
      where.flightDate = {};
      if (filters.dateFrom) {
        where.flightDate.gte = filters.dateFrom;
      }
      if (filters.dateTo) {
        where.flightDate.lte = filters.dateTo;
      }
    }

    const flights = await prisma.flight.findMany({
      where,
      include: {
        enforcementArea: {
          select: { id: true, name: true },
        },
      },
      orderBy: [
        { flightDate: 'desc' },
        { takeoffTime: 'desc' },
      ],
    });

    return flights as FlightWithArea[];
  }
}

export const flightsService = new FlightsService();
