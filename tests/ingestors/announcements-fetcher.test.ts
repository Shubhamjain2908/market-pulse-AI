import { describe, expect, it } from 'vitest';
import {
  classifyTranscriptKind,
  parseNseDate,
} from '../../src/ingestors/nse/announcements-fetcher.js';

describe('parseNseDate', () => {
  it('parses DD-Mon-YYYY with time suffix', () => {
    expect(parseNseDate('18-Jan-2026 23:50:41')).toBe('2026-01-18');
  });

  it('parses DD-Mon-YYYY without time', () => {
    expect(parseNseDate('05-Mar-2026')).toBe('2026-03-05');
  });

  it('parses DD-Mon-YYYY with single-digit day', () => {
    expect(parseNseDate('1-Apr-2026 10:15:00')).toBe('2026-04-01');
  });

  it('parses YYYY-MM-DD ISO format as-is', () => {
    expect(parseNseDate('2026-07-04')).toBe('2026-07-04');
  });

  it('returns null for unparseable strings', () => {
    expect(parseNseDate('')).toBeNull();
    expect(parseNseDate('not-a-date')).toBeNull();
    expect(parseNseDate('2026/07/04')).toBeNull();
  });

  it('handles abbreviated month names case-insensitively', () => {
    expect(parseNseDate('15-Jun-2026')).toBe('2026-06-15');
    expect(parseNseDate('15-jun-2026')).toBe('2026-06-15');
    expect(parseNseDate('15-JUN-2026')).toBe('2026-06-15');
  });

  it('handles Feb and Dec edge cases', () => {
    expect(parseNseDate('28-Feb-2026 00:00:00')).toBe('2026-02-28');
    expect(parseNseDate('31-Dec-2026 23:59:59')).toBe('2026-12-31');
  });
});

describe('classifyTranscriptKind', () => {
  it('classifies PDF with "transcript" in filename as transcript', () => {
    expect(
      classifyTranscriptKind(
        'Reliance_Industries_Q4_FY26_Transcript.pdf',
        'Transcript of conference call',
      ),
    ).toBe('transcript');
  });

  it('classifies PDF with "transcript" in description as transcript', () => {
    expect(classifyTranscriptKind('attachment.pdf', 'Analysts meet transcript')).toBe('transcript');
  });

  it('classifies PDF without transcript keywords as invite', () => {
    expect(classifyTranscriptKind('TCS_Q3_FY26_Invite.pdf', 'Conference call invite')).toBe(
      'invite',
    );
  });

  it('returns null for non-PDF attachments', () => {
    expect(classifyTranscriptKind('presentation.xlsx', 'Investor presentation')).toBeNull();
  });

  it('returns null when both file and text are empty/undefined', () => {
    expect(classifyTranscriptKind(undefined, undefined)).toBeNull();
    expect(classifyTranscriptKind('', '')).toBeNull();
  });

  it('is case-insensitive for transcript keyword', () => {
    expect(
      classifyTranscriptKind('Infosys_Transcript_2026.pdf', 'TRANSCRIPT OF CONFERENCE CALL'),
    ).toBe('transcript');
    expect(classifyTranscriptKind('TRANSCRIPT_Q1.pdf', 'conference call transcript')).toBe(
      'transcript',
    );
  });
});
