import * as https from 'https';
import {BindingScope, injectable} from '@loopback/core';

export interface WhatsAppTemplateMedia {
  type: 'document' | 'image' | 'video';
  url: string;
  fileName?: string;
}

export interface SendWhatsAppTemplateInput {
  /** Customer's mobile number, digits only (no country code) — matches this codebase's normalizeMobile convention and Karix's own examples. */
  to: string;
  /** Karix's approved template id, e.g. 'linkopt1'. */
  templateId: string;
  /** Ordered values for the template's {{1}}, {{2}}, ... placeholders — bodyParams[0] fills {{1}}, matching Karix's 0-indexed bodyParameterValues. */
  bodyParams: string[];
  media?: WhatsAppTemplateMedia;
  reference?: {custRef?: string; messageTag1?: string; conversationId?: string};
}

/**
 * WhatsApp Business API notifications via Karix/Tata's RCM gateway
 * (rcmapi.instaalerts.zone) — the one place that knows how to call it.
 * Generic by design: sendTemplateMessage() takes any approved template id
 * + ordered body params, so a new notification (order ready, delivery
 * confirmation, ...) is just a new call site here, not a new service —
 * see tktcreation/tktdelivery/tktcancellation in the client's own sample
 * CURLs for templates already approved but not yet wired to anything.
 *
 * Credentials are optional, same pattern as GeocodingService/
 * NotificationService: the app must run normally without them, sends
 * just become a no-op (logged once, not per call).
 */
@injectable({scope: BindingScope.SINGLETON})
export class WhatsAppService {
  private warnedMissingCredentials = false;

  private config(): {apiUrl: string; apiKey: string; sourceNumber: string} | null {
    const apiKey = process.env.TATA_WABA_API_KEY?.trim();
    const sourceNumber = process.env.TATA_WABA_SOURCE_NUMBER?.trim();
    // An empty string (env var set but blank) should also fall through to
    // the default below, which ?? alone wouldn't catch.
    const trimmedApiUrl = process.env.TATA_WABA_API_URL?.trim();
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    const apiUrl = trimmedApiUrl || 'https://rcmapi.instaalerts.zone/services/rcm/sendMessage';
    if (apiKey && sourceNumber) return {apiUrl, apiKey, sourceNumber};

    if (!this.warnedMissingCredentials) {
      this.warnedMissingCredentials = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[WhatsAppService] TATA_WABA_API_KEY/TATA_WABA_SOURCE_NUMBER not set — ' +
          'WhatsApp template sends are disabled.',
      );
    }
    return null;
  }

  private postJson(
    url: string,
    apiKey: string,
    body: object,
  ): Promise<{statusCode: number; responseBody: string}> {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const req = https.request(
        {
          hostname: target.hostname,
          path: target.pathname + target.search,
          method: 'POST',
          // Karix's header is literally "Authentication", not the usual
          // "Authorization" — confirmed from the client's own sample CURLs.
          headers: {
            Authentication: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => resolve({statusCode: res.statusCode ?? 0, responseBody: data}));
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  /**
   * Sends one approved WhatsApp template message. Never throws — a missing
   * key, a network error, or a non-2xx response all just resolve to
   * false (logged), so a caller (e.g. right after generating a payment
   * link) never fails the thing it's notifying about just because the
   * WhatsApp send itself failed.
   */
  async sendTemplateMessage(input: SendWhatsAppTemplateInput): Promise<boolean> {
    const config = this.config();
    if (!config) return false;
    if (!input.to?.trim()) return false;

    const bodyParameterValues: Record<string, string> = {};
    input.bodyParams.forEach((value, index) => {
      bodyParameterValues[String(index)] = value;
    });

    const mediaTemplate: Record<string, unknown> = {
      templateId: input.templateId,
      bodyParameterValues,
    };
    if (input.media) {
      mediaTemplate.media = input.media;
    }

    // Karix's own request shape (channel/recipient_type/cust_ref/
    // webHookDNId/...) — not this codebase's naming convention, mirrors
    // the same suppress-comment pattern already used in
    // razorpay.service.ts/geocoding.service.ts for a third-party shape.
    /* eslint-disable @typescript-eslint/naming-convention */
    const payload = {
      message: {
        channel: 'WABA',
        content: {
          preview_url: false,
          type: 'MEDIA_TEMPLATE',
          mediaTemplate,
        },
        recipient: {
          to: input.to.trim(),
          recipient_type: 'individual',
          reference: {
            cust_ref: input.reference?.custRef ?? '',
            messageTag1: input.reference?.messageTag1 ?? '',
            conversationId: input.reference?.conversationId ?? '',
          },
        },
        sender: {from: config.sourceNumber},
        preferences: {webHookDNId: process.env.TATA_WABA_WEBHOOK_DN_ID ?? '1001'},
      },
      metaData: {version: 'v1.0.9'},
    };
    /* eslint-enable @typescript-eslint/naming-convention */

    try {
      const response = await this.postJson(config.apiUrl, config.apiKey, payload);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        // eslint-disable-next-line no-console
        console.error(
          `[WhatsAppService] Send failed (${response.statusCode}) for template ` +
            `"${input.templateId}": ${response.responseBody}`,
        );
        return false;
      }
      return true;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[WhatsAppService] Send error for template "${input.templateId}".`, error);
      return false;
    }
  }
}
