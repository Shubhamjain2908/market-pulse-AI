/**
 * Kite Connect API response shapes.
 * Reference: https://kite.trade/docs/connect/v3/
 *
 * Only the fields we actually consume are typed strictly; everything
 * else flows through the `raw` JSON column for forensics.
 */

import { z } from 'zod';

// -----------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------

export const KiteSessionSchema = z.object({
  user_id: z.string(),
  user_name: z.string().optional(),
  user_shortname: z.string().optional(),
  email: z.string().optional(),
  user_type: z.string().optional(),
  broker: z.string().optional(),
  exchanges: z.array(z.string()).optional(),
  products: z.array(z.string()).optional(),
  order_types: z.array(z.string()).optional(),
  api_key: z.string(),
  access_token: z.string(),
  public_token: z.string().optional(),
  refresh_token: z.string().optional(),
  enctoken: z.string().optional(),
  login_time: z.string().optional(),
});
export type KiteSession = z.infer<typeof KiteSessionSchema>;

// -----------------------------------------------------------------------
// Holdings (cash equity positions held overnight)
// -----------------------------------------------------------------------

export const KiteHoldingSchema = z.object({
  tradingsymbol: z.string(),
  exchange: z.string(),
  isin: z.string().optional(),
  product: z.string().optional(),
  quantity: z.number(),
  t1_quantity: z.number().optional(),
  realised_quantity: z.number().optional(),
  authorised_quantity: z.number().optional(),
  authorised_date: z.string().optional(),
  opening_quantity: z.number().optional(),
  collateral_quantity: z.number().optional(),
  collateral_type: z.string().optional(),
  discrepancy: z.boolean().optional(),
  average_price: z.number(),
  last_price: z.number(),
  close_price: z.number().optional(),
  pnl: z.number(),
  day_change: z.number().optional(),
  day_change_percentage: z.number().optional(),
});
export type KiteHolding = z.infer<typeof KiteHoldingSchema>;

// -----------------------------------------------------------------------
// LTP (last traded price) batch lookup
// -----------------------------------------------------------------------

export const KiteLtpEntrySchema = z.object({
  instrument_token: z.number(),
  last_price: z.number(),
});
export const KiteLtpResponseSchema = z.record(z.string(), KiteLtpEntrySchema);
export type KiteLtpEntry = z.infer<typeof KiteLtpEntrySchema>;

// -----------------------------------------------------------------------
// Full quote (LTP + OHLC + depth + volume)
// -----------------------------------------------------------------------

export const KiteQuoteOhlcSchema = z.object({
  open: z.number().optional(),
  high: z.number().optional(),
  low: z.number().optional(),
  close: z.number().optional(),
});

export const KiteQuoteEntrySchema = z.object({
  instrument_token: z.number(),
  timestamp: z.string().optional(),
  last_price: z.number(),
  last_quantity: z.number().optional(),
  last_trade_time: z.string().optional(),
  volume: z.number().optional(),
  buy_quantity: z.number().optional(),
  sell_quantity: z.number().optional(),
  ohlc: KiteQuoteOhlcSchema.optional(),
  net_change: z.number().optional(),
  oi: z.number().optional(),
});
export const KiteQuoteResponseSchema = z.record(z.string(), KiteQuoteEntrySchema);
export type KiteQuoteEntry = z.infer<typeof KiteQuoteEntrySchema>;

// -----------------------------------------------------------------------
// Generic envelope
// -----------------------------------------------------------------------

export const KiteEnvelopeSchema = z.object({
  status: z.enum(['success', 'error']),
  data: z.unknown(),
  message: z.string().optional(),
  error_type: z.string().optional(),
});
export type KiteEnvelope = z.infer<typeof KiteEnvelopeSchema>;
