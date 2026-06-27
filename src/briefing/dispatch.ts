/**
 * Route composed briefing HTML to the configured delivery channel.
 * Shared by the CLI and the in-process scheduler.
 */

import { config } from '../config/env.js';
import { deliverToEmail } from './delivery/email.js';
import { deliverToFile } from './delivery/file.js';

export async function deliverBriefing(
  html: string,
  date: string,
  method: 'file' | 'email' = config.BRIEFING_DELIVERY,
): Promise<void> {
  if (method === 'file') {
    deliverToFile(html, date);
    return;
  }
  if (method === 'email') {
    await deliverToEmail(html, date);
    return;
  }
  throw new Error(`Unsupported briefing delivery method: ${method}`);
}
