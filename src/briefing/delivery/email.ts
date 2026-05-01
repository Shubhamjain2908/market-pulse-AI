/**
 * SMTP/Gmail delivery for briefing HTML using nodemailer.
 *
 * Gmail personal setup:
 *  - SMTP_HOST=smtp.gmail.com
 *  - SMTP_PORT=587
 *  - SMTP_USER=<your gmail>
 *  - SMTP_PASS=<app password, not account password>
 *  - SMTP_FROM=<sender mailbox>
 *  - SMTP_TO=<recipient mailbox>
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import nodemailer from 'nodemailer';
import { config } from '../../config/env.js';
import { getDb } from '../../db/index.js';
import { child } from '../../logger.js';

const log = child({ component: 'briefing-delivery-email' });

export interface EmailDeliveryResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  briefingId: number;
}

export async function deliverToEmail(
  html: string,
  date: string,
  db: DatabaseType = getDb(),
): Promise<EmailDeliveryResult> {
  ensureEmailConfig();

  const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: {
      user: config.SMTP_USER,
      pass: config.SMTP_PASS,
    },
  });

  const to = splitCsv(config.SMTP_TO);
  const info = await transporter.sendMail({
    from: config.SMTP_FROM,
    to,
    subject: `Market Pulse Briefing - ${date}`,
    text: buildPlainTextFallback(date),
    html,
  });

  const insert = db.prepare(`
    INSERT INTO briefings (date, html_content, delivery_method, delivered_at)
    VALUES (?, ?, 'email', datetime('now'))
  `);
  const result = insert.run(date, html);
  const briefingId = Number(result.lastInsertRowid);

  const accepted = (info.accepted ?? []).map(String);
  const rejected = (info.rejected ?? []).map(String);
  const messageId = info.messageId ?? 'unknown';

  log.info({ messageId, accepted, rejected, briefingId }, 'briefing delivered via email');
  return { messageId, accepted, rejected, briefingId };
}

function ensureEmailConfig(): void {
  const missing: string[] = [];
  if (!config.SMTP_USER) missing.push('SMTP_USER');
  if (!config.SMTP_PASS) missing.push('SMTP_PASS');
  if (!config.SMTP_FROM) missing.push('SMTP_FROM');
  if (!config.SMTP_TO) missing.push('SMTP_TO');
  if (missing.length > 0) {
    throw new Error(
      `email delivery requires ${missing.join(', ')}. Fill them in .env (Gmail: use an App Password).`,
    );
  }
}

function splitCsv(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function buildPlainTextFallback(date: string): string {
  return [
    `Market Pulse briefing for ${date}`,
    '',
    'This email contains an HTML briefing.',
    'If your mail client hides it, open the attached/rendered HTML part.',
  ].join('\n');
}
