import { describe, expect, it } from 'vitest';
import { heuristicInstrumentSector } from '../../src/market/instrument-sector-heuristic.js';

describe('heuristicInstrumentSector', () => {
  it('classifies SGB symbols without -GB suffix', () => {
    expect(heuristicInstrumentSector('SGBJUN31I')).toBe('Sovereign Gold Bond');
    expect(heuristicInstrumentSector('sgbde31iii')).toBe('Sovereign Gold Bond');
  });

  it('classifies legacy -GB symbols as sovereign gold bonds', () => {
    expect(heuristicInstrumentSector('SGBDE31III-GB')).toBe('Sovereign Gold Bond');
  });
});
