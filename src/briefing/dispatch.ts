/**
 * Route composed briefing HTML to the configured delivery channel.
 * Shared by the CLI and the in-process scheduler.
 */

import { config } from '../config/env.js';
import { child } from '../logger.js';
import { deliverToEmail } from './delivery/email.js';
import { deliverToFile } from './delivery/file.js';

const log = child({ component: 'briefing-dispatch' });

export async function deliverBriefing(
  html: string,
  date: string,
  method: 'file' | 'email' | 'slack' | 'telegram' = config.BRIEFING_DELIVERY,
): Promise<void> {
  if (method === 'file') {
    deliverToFile(html, date);
    return;
  }
  if (method === 'email') {
    await deliverToEmail(html, date);
    return;
  }
  log.warn({ delivery: method }, 'delivery channel not implemented yet — briefing not delivered');
}
