import { describe, expect, it } from 'vitest';
import { parseScreenerHtml } from '../../../src/ingestors/screener/parser.js';

/** Mirrors Screener consolidated layout for growth tables + quarterly shareholding. */
const kotakLikeSnapshot = `
<div class="company-ratios">
  <ul id="top-ratios">
    <li class="flex flex-space-between">
      <span class="name">Market Cap</span>
      <span class="nowrap value">₹<span class="number">3,84,978</span> Cr.</span>
    </li>
    <li class="flex flex-space-between">
      <span class="name">Stock P/E</span>
      <span class="nowrap value"><span class="number">21</span></span>
    </li>
    <li class="flex flex-space-between">
      <span class="name">Debt / Equity</span>
      <span class="nowrap value"><span class="number">0.42</span></span>
    </li>
    <li class="flex flex-space-between">
      <span class="name">ROE</span>
      <span class="nowrap value"><span class="number">11</span>%</span>
    </li>
    <li class="flex flex-space-between">
      <span class="name">ROCE</span>
      <span class="nowrap value"><span class="number">7</span>%</span>
    </li>
    <li class="flex flex-space-between">
      <span class="name">Dividend Yield</span>
      <span class="nowrap value"><span class="number">0.1</span>%</span>
    </li>
  </ul>
</div>
<div style="display: grid;">
  <table class="ranges-table">
    <tr><th colspan="2">Compounded Sales Growth</th></tr>
    <tr><td>10 Years:</td><td>13%</td></tr>
    <tr><td>TTM:</td><td>6%</td></tr>
  </table>
  <table class="ranges-table">
    <tr><th colspan="2">Compounded Profit Growth</th></tr>
    <tr><td>3 Years:</td><td>8%</td></tr>
    <tr><td>TTM:</td><td>-14%</td></tr>
  </table>
</div>
<section id="shareholding">
  <table class="data-table">
    <thead><tr><th></th><th>Dec 2024</th><th>Mar 2025</th></tr></thead>
    <tbody>
      <tr>
        <td class="text"><button>Promoters</button></td>
        <td>25.88%</td>
        <td>25.87%</td>
      </tr>
    </tbody>
  </table>
</section>
`;

const minimalTopRatiosOnly = `
<ul id="top-ratios">
  <li><span class="name">Market Cap</span><span class="nowrap value">₹<span class="number">1,000</span> Cr.</span></li>
  <li><span class="name">Stock P/E</span><span class="nowrap value"><span class="number">12</span></span></li>
  <li><span class="name">ROE</span><span class="nowrap value"><span class="number">15</span>%</span></li>
  <li><span class="name">ROCE</span><span class="nowrap value"><span class="number">14</span>%</span></li>
  <li><span class="name">Dividend Yield</span><span class="nowrap value"><span class="number">2</span>%</span></li>
</ul>
`;

const shareholdingOneQuarter = `
<ul id="top-ratios">
  <li><span class="name">Market Cap</span><span class="nowrap value">₹<span class="number">500</span> Cr.</span></li>
</ul>
<section id="shareholding">
  <table class="data-table">
    <thead><tr><th></th><th>Mar 2025</th></tr></thead>
    <tbody>
      <tr>
        <td>Promoters</td>
        <td>51.00%</td>
      </tr>
    </tbody>
  </table>
</section>
`;

/** Continuation-row style (label + period + value, TTM on follow-up row). */
const growthContinuationStyle = `
<ul id="top-ratios">
  <li><span class="name">Market Cap</span><span class="nowrap value">₹<span class="number">100</span> Cr.</span></li>
</ul>
<table class="ranges-table">
  <tr><td>Compounded Sales Growth</td><td>10 Years:</td><td>9%</td></tr>
  <tr><td></td><td>TTM:</td><td>12%</td></tr>
</table>
`;

describe('parseScreenerHtml', () => {
  it('parses growth, shareholding, debt/equity bar key, and promoter QoQ from snapshot-like HTML', () => {
    const r = parseScreenerHtml(kotakLikeSnapshot, { symbol: 'KOTAKBANK', source: 'test' });
    if (r === null) {
      expect.fail('expected parse');
    }
    expect(r.marketCap).toBeDefined();
    expect(r.pe).toBe(21);
    expect(r.revenueGrowthYoY).toBe(6);
    expect(r.profitGrowthYoY).toBe(-14);
    expect(r.debtToEquity).toBe(0.42);
    expect(r.promoterHoldingPct).toBe(25.87);
    expect(r.promoterHoldingChangeQoQ).toBe(-0.01);
    expect(r.dividendYield).toBe(0.1);
    expect(r.roe).toBe(11);
    expect(r.roce).toBe(7);
  });

  it('leaves extended fundamentals unset when only top ratios exist', () => {
    const r = parseScreenerHtml(minimalTopRatiosOnly, { symbol: 'MIN', source: 'test' });
    if (r === null) {
      expect.fail('expected parse');
    }
    expect(r.marketCap).toBeDefined();
    expect(r.revenueGrowthYoY).toBeUndefined();
    expect(r.profitGrowthYoY).toBeUndefined();
    expect(r.promoterHoldingPct).toBeUndefined();
    expect(r.promoterHoldingChangeQoQ).toBeUndefined();
    expect(r.debtToEquity).toBeUndefined();
  });

  it('sets promoterHoldingChangeQoQ undefined when only one quarter column has data', () => {
    const r = parseScreenerHtml(shareholdingOneQuarter, { symbol: 'ONEQ', source: 'test' });
    if (r === null) {
      expect.fail('expected parse');
    }
    expect(r.promoterHoldingPct).toBe(51);
    expect(r.promoterHoldingChangeQoQ).toBeUndefined();
  });

  it('reads compounded sales TTM from continuation rows in ranges-table', () => {
    const r = parseScreenerHtml(growthContinuationStyle, { symbol: 'CONT', source: 'test' });
    if (r === null) {
      expect.fail('expected parse');
    }
    expect(r.revenueGrowthYoY).toBe(12);
  });

  it('maps debt to equity alternate label from the ratio bar', () => {
    const html = `
      <ul id="top-ratios">
        <li><span class="name">Market Cap</span><span class="nowrap value">₹<span class="number">100</span> Cr.</span></li>
        <li><span class="name">Debt to Equity</span><span class="nowrap value"><span class="number">1.5</span></span></li>
      </ul>`;
    const r = parseScreenerHtml(html, { symbol: 'DEBT', source: 'test' });
    if (r === null) {
      expect.fail('expected parse');
    }
    expect(r.debtToEquity).toBe(1.5);
  });
});
