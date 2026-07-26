/**
 * Flights Controller
 * Handles HTTP requests for flight records
 */

import { Response } from 'express';
import { validationResult } from 'express-validator';
import { AuthenticatedRequest } from '../types';
import { flightsService } from '../services/flights.service';
import { logger } from '../config/logger';

/**
 * Create a new flight
 * POST /flights
 */
export async function createFlight(req: AuthenticatedRequest, res: Response): Promise<void> {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, error: errors.array()[0].msg });
    return;
  }

  try {
    const { enforcementAreaId, location, flightDate, takeoffTime, landingTime, remarks } = req.body;

    const flight = await flightsService.create({
      enforcementAreaId,
      location,
      flightDate: new Date(flightDate),
      takeoffTime,
      landingTime,
      remarks,
      createdBy: req.user?.id,
    });

    res.status(201).json({
      success: true,
      data: flight,
      message: 'Flight created successfully',
    });
  } catch (error: any) {
    logger.error('Error creating flight:', error);

    if (error.code === 'P2002') {
      res.status(400).json({
        success: false,
        error: 'A flight with this location, date, and time already exists',
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create flight',
    });
  }
}

/**
 * Get all flights with filters and pagination
 * GET /flights
 */
export async function getFlights(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const {
      enforcementAreaId,
      dateFrom,
      dateTo,
      startDate,
      endDate,
      search,
      page = '1',
      limit = '20',
    } = req.query;

    // Support both naming conventions
    const fromDate = startDate || dateFrom;
    const toDate = endDate || dateTo;

    const result = await flightsService.getAll({
      enforcementAreaId: enforcementAreaId as string,
      dateFrom: fromDate ? new Date(fromDate as string) : undefined,
      dateTo: toDate ? new Date(toDate as string) : undefined,
      search: search as string,
      page: parseInt(page as string, 10),
      limit: parseInt(limit as string, 10),
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    logger.error('Error fetching flights:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch flights',
    });
  }
}

/**
 * Get a single flight by ID
 * GET /flights/:id
 */
export async function getFlightById(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const flight = await flightsService.getById(id);

    if (!flight) {
      res.status(404).json({
        success: false,
        error: 'Flight not found',
      });
      return;
    }

    res.json({
      success: true,
      data: flight,
    });
  } catch (error: any) {
    logger.error('Error fetching flight:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch flight',
    });
  }
}

/**
 * Update a flight
 * PATCH /flights/:id
 */
export async function updateFlight(req: AuthenticatedRequest, res: Response): Promise<void> {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, error: errors.array()[0].msg });
    return;
  }

  try {
    const { id } = req.params;
    const { enforcementAreaId, location, flightDate, takeoffTime, landingTime, remarks } = req.body;

    const flight = await flightsService.update(id, {
      enforcementAreaId,
      location,
      flightDate: flightDate ? new Date(flightDate) : undefined,
      takeoffTime,
      landingTime,
      remarks,
    });

    res.json({
      success: true,
      data: flight,
      message: 'Flight updated successfully',
    });
  } catch (error: any) {
    logger.error('Error updating flight:', error);

    if (error.message === 'Flight not found') {
      res.status(404).json({
        success: false,
        error: 'Flight not found',
      });
      return;
    }

    if (error.code === 'P2002') {
      res.status(400).json({
        success: false,
        error: 'A flight with this location, date, and time already exists',
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update flight',
    });
  }
}

/**
 * Delete a flight
 * DELETE /flights/:id
 */
export async function deleteFlight(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    await flightsService.delete(id);

    res.json({
      success: true,
      message: 'Flight deleted successfully',
    });
  } catch (error: any) {
    logger.error('Error deleting flight:', error);

    if (error.message === 'Flight not found') {
      res.status(404).json({
        success: false,
        error: 'Flight not found',
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete flight',
    });
  }
}

/**
 * Get flight statistics
 * GET /flights/stats
 */
export async function getFlightStats(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { enforcementAreaId, dateFrom, dateTo, startDate, endDate } = req.query;

    // Support both naming conventions
    const fromDate = startDate || dateFrom;
    const toDate = endDate || dateTo;

    const stats = await flightsService.getStats({
      enforcementAreaId: enforcementAreaId as string,
      dateFrom: fromDate ? new Date(fromDate as string) : undefined,
      dateTo: toDate ? new Date(toDate as string) : undefined,
    });

    res.json({
      success: true,
      data: stats,
    });
  } catch (error: any) {
    logger.error('Error fetching flight stats:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch flight statistics',
    });
  }
}

/**
 * Export flights for Excel download
 * GET /flights/export
 */
export async function exportFlights(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { enforcementAreaId, dateFrom, dateTo, startDate, endDate } = req.query;

    // Support both naming conventions
    const fromDate = startDate || dateFrom;
    const toDate = endDate || dateTo;

    const flights = await flightsService.getAllForExport({
      enforcementAreaId: enforcementAreaId as string,
      dateFrom: fromDate ? new Date(fromDate as string) : undefined,
      dateTo: toDate ? new Date(toDate as string) : undefined,
    });

    res.json({
      success: true,
      data: flights,
    });
  } catch (error: any) {
    logger.error('Error exporting flights:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to export flights',
    });
  }
}
