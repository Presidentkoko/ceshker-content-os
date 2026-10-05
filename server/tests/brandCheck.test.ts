import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/pool.js', () => ({ query: vi.fn(), tx: vi.fn() }));
vi.mock('../services/secretbox.js', () => ({ open: (s: string) => s, seal: (s: string) => s }));
vi.mock('../services/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../services/googleOAuth.js', () => ({ publicBaseUrl: () => 'https://example.test' }));

const { __test } = await import('../services/canvaMcp.js');
const rules = { approved_logo_asset_ids: ['MAHWr4iPo6k'], blocked_asset_ids: ['MAHWIeM0tWs'], logo_asset_for_fix: 'MAHWr4iPo6k' };

// Shape of Canva MCP read-design structured content (trimmed from a real Content OS design).
const page = (logoMedia: string) => ({
  pages: [{
    type: 'fixed', id: 'PB1', isEditable: true,
    background: { media: { type: 'image', mediaId: 'MAHWIXOOGdM' } },
    elements: [
      { id: 'LB1', locator_id: 'PB1-LB1', type: 'rect', top: 2008, left: 110, width: 226, height: 224, fill: { media: { type: 'image', mediaId: logoMedia } } },
      { id: 'LB2', locator_id: 'PB1-LB2', type: 'text', top: 2035, left: 388, width: 638, height: 114, textRegions: [{ characters: 'Ceshker' }] },
      { id: 'LB3', locator_id: 'PB1-LB3', type: 'text', top: 306, left: 109, width: 1680, height: 299, textRegions: [{ characters: 'What Should We Cover Next?' }], dataFieldLabel: 'headline' },
    ],
  }],
});

describe('brand check', () => {
  it('fails a design that carries a blocked logo', () => {
    const pages = __test.scanPages(page('MAHWIeM0tWs'));
    expect(pages[0].media.find((m) => m.mediaId === 'MAHWIeM0tWs')?.locator).toBe('PB1-LB1');
    expect(__test.judge(pages, rules).status).toBe('fail');
  });
  it('passes a design with the approved logo', () => {
    expect(__test.judge(__test.scanPages(page('MAHWr4iPo6k')), rules).status).toBe('pass');
  });
  it('asks for review when no logo is present', () => {
    expect(__test.judge(__test.scanPages(page('MAHWsomethingElse')), rules).status).toBe('review');
  });
  it('collects text boxes with their data field', () => {
    const texts = __test.scanPages(page('x'))[0].texts;
    expect(texts.map((t) => t.text)).toEqual(['Ceshker', 'What Should We Cover Next?']);
    expect(texts[1].field).toBe('headline');
  });
});
