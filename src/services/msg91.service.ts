/**
 * MSG91 SMS Service
 * Sends SMS using MSG91 API with DLT templates
 * Used for case/notice notifications to vessel owners
 */

import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';
import { logger } from '../config/logger';

// ============================================================
// INTERFACES
// ============================================================

interface SendSmsResult {
  success: boolean;
  messageId?: string;
  error?: string;
  phone: string;
}

interface DetectedViolationData {
  district: string;
  vesselName: string;
  vesselNumber: string;
  ownerName: string;
  date: string;
  time: string;
  latitude: string;
  longitude: string;
  violationType: string;
}

interface HearingNoticeData {
  district: string;
  vesselName: string;
  vesselNumber: string;
  ownerName: string;
  observationDate: string;
  officeName: string;
  hearingDate: string;
}

// ============================================================
// MSG91 SERVICE CLASS
// ============================================================

class Msg91Service {
  private client: AxiosInstance | null = null;
  private isConfigured: boolean;

  constructor() {
    this.isConfigured = Boolean(
      env.msg91AuthKey &&
      env.msg91AuthKey !== 'your_msg91_auth_key'
    );

    if (this.isConfigured) {
      this.client = axios.create({
        baseURL: 'https://control.msg91.com/api/v5',
        headers: {
          'authkey': env.msg91AuthKey,
          'Content-Type': 'application/json',
        },
      });

      logger.info('MSG91 SMS service initialized');
    } else {
      logger.warn('MSG91 auth key not configured - SMS will be logged only');
    }
  }

  /**
   * Format phone number for MSG91 (remove + and ensure 91 prefix)
   */
  private formatPhoneNumber(phone: string): string {
    // Remove spaces, dashes, and other characters
    let cleaned = phone.replace(/[\s\-\(\)\+]/g, '');

    // If starts with 0, replace with 91
    if (cleaned.startsWith('0')) {
      cleaned = '91' + cleaned.substring(1);
    }
    // If doesn't start with 91, add it
    else if (!cleaned.startsWith('91')) {
      cleaned = '91' + cleaned;
    }

    return cleaned;
  }

  /**
   * Send SMS using MSG91 Flow API with template
   */
  private async sendTemplateMessage(
    phone: string,
    templateId: string,
    variables: Record<string, string>
  ): Promise<SendSmsResult> {
    const formattedPhone = this.formatPhoneNumber(phone);

    if (!this.isConfigured || !this.client) {
      logger.info(`[MSG91 LOG] Would send to ${formattedPhone}: Template=${templateId}, Vars=${JSON.stringify(variables)}`);
      return {
        success: true,
        messageId: 'log-only-' + Date.now(),
        phone: formattedPhone,
      };
    }

    try {
      // MSG91 Flow API payload
      const payload = {
        template_id: templateId,
        short_url: '0',
        recipients: [
          {
            mobiles: formattedPhone,
            ...variables,
          },
        ],
      };

      logger.info(`Sending SMS via MSG91 to ${formattedPhone}...`);
      const response = await this.client.post('/flow/', payload);

      logger.info(`MSG91 response: ${JSON.stringify(response.data)}`);

      const messageId = response.data?.request_id || response.data?.message || `msg91-${Date.now()}`;

      if (response.data?.type === 'success' || response.status === 200) {
        logger.info(`SMS sent to ${formattedPhone}: ${messageId}`);
        return {
          success: true,
          messageId,
          phone: formattedPhone,
        };
      } else {
        throw new Error(response.data?.message || 'Unknown error');
      }
    } catch (error: any) {
      const errorResponse = error?.response?.data;
      const errorMessage = errorResponse
        ? JSON.stringify(errorResponse)
        : (error instanceof Error ? error.message : 'Unknown error');
      logger.error(`Failed to send SMS to ${formattedPhone}: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
        phone: formattedPhone,
      };
    }
  }

  /**
   * Send Detected Violation SMS
   * Template: Detected_Violation (6a7d8959b6a469abad0709a3)
   *
   * Variables:
   * - ##district## - District name
   * - ##name## - Vessel name
   * - ##number## - Vessel number
   * - ##owner## - Owner name
   * - ##date## - Observation date
   * - ##time## - Observation time
   * - ##lat## - Latitude
   * - ##long## - Longitude
   * - ##type## - Violation type
   */
  async sendDetectedViolationSms(
    phoneNumbers: string[],
    data: DetectedViolationData
  ): Promise<{ sent: number; failed: number; results: SendSmsResult[] }> {
    const results: SendSmsResult[] = [];
    let sent = 0;
    let failed = 0;

    // Filter valid phone numbers
    const validPhones = phoneNumbers.filter(p => p && p.trim().length >= 10);

    if (validPhones.length === 0) {
      logger.warn('No valid phone numbers for Detected Violation SMS');
      return { sent, failed, results };
    }

    const variables = {
      district: data.district,
      name: data.vesselName,
      number: data.vesselNumber,
      owner: data.ownerName,
      date: data.date,
      time: data.time,
      lat: data.latitude,
      long: data.longitude,
      type: data.violationType,
    };

    for (const phone of validPhones) {
      const result = await this.sendTemplateMessage(
        phone,
        env.msg91DetectedViolationTemplateId,
        variables
      );
      results.push(result);
      if (result.success) {
        sent++;
      } else {
        failed++;
      }

      // Small delay between messages
      await this.delay(100);
    }

    logger.info(`Detected Violation SMS: ${sent}/${validPhones.length} sent`);
    return { sent, failed, results };
  }

  /**
   * Send Hearing Notice SMS
   * Template: HEARING_NOTICE (6a7d86e76e15dc01ef0b25f2)
   *
   * Variables:
   * - ##name## - District name
   * - ##name1## - Vessel name
   * - ##number## - Vessel number
   * - ##owner## - Owner name
   * - ##date## - Observation date
   * - ##office## - Office name (ACF office)
   * - ##hearingdate## - Hearing date
   */
  async sendHearingNoticeSms(
    phoneNumbers: string[],
    data: HearingNoticeData
  ): Promise<{ sent: number; failed: number; results: SendSmsResult[] }> {
    const results: SendSmsResult[] = [];
    let sent = 0;
    let failed = 0;

    // Filter valid phone numbers
    const validPhones = phoneNumbers.filter(p => p && p.trim().length >= 10);

    if (validPhones.length === 0) {
      logger.warn('No valid phone numbers for Hearing Notice SMS');
      return { sent, failed, results };
    }

    const variables = {
      name: data.district,
      name1: data.vesselName,
      number: data.vesselNumber,
      owner: data.ownerName,
      date: data.observationDate,
      office: data.officeName,
      hearingdate: data.hearingDate,
    };

    for (const phone of validPhones) {
      const result = await this.sendTemplateMessage(
        phone,
        env.msg91HearingNoticeTemplateId,
        variables
      );
      results.push(result);
      if (result.success) {
        sent++;
      } else {
        failed++;
      }

      // Small delay between messages
      await this.delay(100);
    }

    logger.info(`Hearing Notice SMS: ${sent}/${validPhones.length} sent`);
    return { sent, failed, results };
  }

  /**
   * Send test SMS
   */
  async sendTestSms(phone: string): Promise<SendSmsResult> {
    const testData: DetectedViolationData = {
      district: 'Test District',
      vesselName: 'Test Vessel',
      vesselNumber: 'TEST-123',
      ownerName: 'Test Owner',
      date: new Date().toLocaleDateString('en-IN'),
      time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      latitude: '18.9220',
      longitude: '72.8347',
      violationType: 'Test Violation',
    };

    const result = await this.sendDetectedViolationSms([phone], testData);
    return result.results[0] || { success: false, error: 'No result', phone };
  }

  /**
   * Utility: delay execution
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const msg91Service = new Msg91Service();
