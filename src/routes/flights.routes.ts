/**
 * Flights Routes
 * - Stats: Available to all authenticated users
 * - CRUD operations: Admin only
 */

import { Router } from 'express';
import { body } from 'express-validator';
import {
  createFlight,
  getFlights,
  getFlightById,
  updateFlight,
  deleteFlight,
  getFlightStats,
  exportFlights,
} from '../controllers/flights.controller';
import { authenticate, requireAdmin, asyncHandler } from '../middleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

// =============================================================================
// STATISTICS (Available to all authenticated users)
// =============================================================================

// GET /flights/stats - Get flight statistics (all authenticated users)
router.get('/stats', asyncHandler(getFlightStats));

// =============================================================================
// ADMIN-ONLY ROUTES
// =============================================================================

// GET /flights/export - Export flights for Excel (admin only)
router.get('/export', requireAdmin, asyncHandler(exportFlights));

// =============================================================================
// CRUD ROUTES (Admin only)
// =============================================================================

// GET /flights - List all flights with filters
router.get('/', requireAdmin, asyncHandler(getFlights));

// POST /flights - Create a new flight
router.post(
  '/',
  requireAdmin,
  [
    body('enforcementAreaId').notEmpty().withMessage('District is required'),
    body('location').trim().notEmpty().withMessage('Location is required'),
    body('flightDate').notEmpty().withMessage('Flight date is required'),
    body('takeoffTime')
      .notEmpty()
      .withMessage('Takeoff time is required')
      .matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('Invalid takeoff time format (HH:mm)'),
    body('landingTime')
      .notEmpty()
      .withMessage('Landing time is required')
      .matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('Invalid landing time format (HH:mm)'),
  ],
  asyncHandler(createFlight)
);

// GET /flights/:id - Get a single flight
router.get('/:id', requireAdmin, asyncHandler(getFlightById));

// PATCH /flights/:id - Update a flight
router.patch(
  '/:id',
  requireAdmin,
  [
    body('takeoffTime')
      .optional()
      .matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('Invalid takeoff time format (HH:mm)'),
    body('landingTime')
      .optional()
      .matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('Invalid landing time format (HH:mm)'),
  ],
  asyncHandler(updateFlight)
);

// DELETE /flights/:id - Delete a flight
router.delete('/:id', requireAdmin, asyncHandler(deleteFlight));

export default router;
