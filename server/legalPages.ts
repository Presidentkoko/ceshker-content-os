import type { Express } from 'express';
import { brand } from './brand.js';

// Public privacy policy and terms pages. Google requires both (plus a home page) before an OAuth
// app can move from "Testing" to "In production".

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · ${brand.name}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#1f2937;background:#fff}h1{font-size:26px}h2{font-size:18px;margin-top:28px}a{color:#1d4ed8}@media(prefers-color-scheme:dark){body{background:#0b1220;color:#e5e7eb}a{color:#93c5fd}}</style></head>
<body>${body}<p style="margin-top:40px;font-size:14px;opacity:.7">Last updated September 30, 2026</p></body></html>`;

const PRIVACY = page('Privacy policy', `
<h1>Privacy policy</h1>
<p>This app is used by ${brand.name} and its team to plan, approve and publish ${brand.subtitle.replace(' · ', ' and ')} content on YouTube, Facebook and Instagram.</p>
<h2>What we access</h2>
<p>When a channel owner connects a YouTube channel, the app receives permission to view and manage that channel: reading its videos, playlists and statistics, uploading videos, and updating titles, descriptions, visibility and playlists. It does not access Gmail, contacts or any other Google data.</p>
<h2>How we use it</h2>
<p>Access is used only to upload and schedule the team's own videos, keep the dashboard in step with the channel, and show the channel's views, likes and comments to the team. Nothing is published without approval by a team member.</p>
<h2>Storage and sharing</h2>
<p>Access tokens are stored encrypted and are never shown to anyone. We do not sell, rent or share any data with third parties, and we do not use it for advertising.</p>
<h2>Removing access</h2>
<p>A channel owner can disconnect at any time from the app's Settings, or by removing the app at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. Stored tokens are then deleted.</p>
<h2>Contact</h2>
<p>Questions: <a href="mailto:jeruzgarde@gmail.com">jeruzgarde@gmail.com</a>.</p>`);

const TERMS = page('Terms of service', `
<h1>Terms of service</h1>
<p>This app is an internal tool for ${brand.name} and people it authorizes. Access is by invitation only.</p>
<p>By connecting a YouTube, Facebook or Instagram account you allow the team to manage the content on it as described in the <a href="/privacy">privacy policy</a>. You can disconnect at any time.</p>
<p>The app is provided as is. Content published through it remains the responsibility of ${brand.name}, and use of each platform remains subject to that platform's own terms.</p>
<p>Contact: <a href="mailto:jeruzgarde@gmail.com">jeruzgarde@gmail.com</a>.</p>`);

export function mountLegalPages(app: Express) {
  app.get('/privacy', (_req, res) => res.type('html').send(PRIVACY));
  app.get('/terms', (_req, res) => res.type('html').send(TERMS));
}
