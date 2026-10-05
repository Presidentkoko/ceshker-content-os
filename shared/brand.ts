/**
 * Brand presets. One Content OS deployment serves one brand, chosen with the BRAND
 * environment variable. Everything brand-specific (names, categories, campaigns,
 * the video library label, the voice guide) lives here so a second brand is a
 * second Railway service with different variables, not a fork of the code.
 */

export interface BrandCampaign {
  slug: string;
  name: string;
  description: string;
  target_count: number | null;
  lead_magnet_name: string | null;
  cta_text: string | null;
}

export interface Brand {
  key: 'ceshker' | 'aim';
  /** Full name shown in titles and legal pages. */
  name: string;
  /** Two-letter mark in the sidebar. */
  mark: string;
  /** Sidebar subtitle, e.g. "Ceshker Group · NFAMation". */
  subtitle: string;
  /** Name shown on the Facebook / Instagram preview card. */
  socialName: string;
  /** Name shown on the YouTube preview card and the video library. */
  videoBrand: string;
  /** Video library page title and blurb. */
  libraryTitle: string;
  libraryBlurb: string;
  /** Campaign every Drive-imported video belongs to. */
  libraryCampaignSlug: string;
  categories: readonly string[];
  campaigns: BrandCampaign[];
  disclaimer: string;
  /** Who owns the Meta Business, Canva team and YouTube channel (used in setup hints). */
  metaBusiness: string;
  canvaTeam: string;
  youtubeOwner: string;
  /** Brand voice and posting rules, shown to writers in Settings and the post panel. */
  voice: string;
}

const CESHKER: Brand = {
  key: 'ceshker',
  name: 'Ceshker Group',
  mark: 'CO',
  subtitle: 'Ceshker Group · NFAMation',
  socialName: 'Ceshker Group',
  videoBrand: 'NFAMation',
  libraryTitle: 'NFAMation Video Library',
  libraryBlurb: 'Every final NFAMation video, its YouTube title and playlist, and what it still needs before upload.',
  libraryCampaignSlug: 'nfamation-library',
  categories: [
    'NFAMation', 'J.A.M. Session', 'Event', 'Power Hour', 'Birthday', 'Anniversary', 'Testimonial', 'Closing',
    'Property', 'Poll', 'ULTRA', 'Education', 'Hiring', 'Holiday', 'General',
  ],
  campaigns: [
    {
      slug: 'nfamation-library',
      name: 'NFAMation YouTube Library',
      description:
        'All final NFAMation videos in one YouTube section, promoted independently of any posting schedule. Working series name proposed: "Before You Close: 50 Texas Creative Finance Lessons".',
      target_count: 50,
      lead_magnet_name: 'Texas Creative Finance Closing Checklist',
      cta_text: 'Download the free Texas Creative Finance Closing Checklist.',
    },
    { slug: 'jam-sessions', name: 'J.A.M. Sessions (Skool)', description: 'Recurring J.A.M. Session promotion for the ULTRA community on Skool.', target_count: null, lead_magnet_name: null, cta_text: null },
    { slug: 'black-sheep-2026', name: 'Black Sheep Convention 2026', description: 'San Antonio, September 25–26. T. Alan Ceshker presents "Mortgage Wraps Done Right".', target_count: null, lead_magnet_name: null, cta_text: null },
    { slug: 'power-hour', name: 'Power Hour with T. Alan', description: 'Monthly Power Hour announcements and reminders.', target_count: null, lead_magnet_name: null, cta_text: null },
    { slug: 'ultra-launch', name: 'ULTRA launch', description: 'ULTRA launch sequence (Days 1–13) and ULTRA promotion.', target_count: null, lead_magnet_name: null, cta_text: null },
  ],
  disclaimer: 'General educational information only. Not legal advice and does not create an attorney-client relationship.',
  metaBusiness: 'T Alan Ceshker’s Business',
  canvaTeam: 'Ceshker Group Canva team account',
  youtubeOwner: 'the account that owns the NFAMation channel',
  voice: '',
};

const AIM_VOICE = `Derek's voice (from the DSR Social Media SOP)
Derek is a broker, investor and developer in Austin, founder of Deal Smith Realty and host of the Austin Investment Meetup (AIM).

Sound like: casual, confident and real. Direct, like a conversation over coffee, not a sales pitch. Speak to investors and agents, not at them. Humor and straight talk when it fits. Simplify real estate terms without talking down. Captions should read like Derek typed them.

Never: "dream home", "don't miss out", "perfect for entertaining", "discover this gem"; cheesy motivational quotes; emoji overload (1–3 max, only if they fit); fake urgency; the word "legit"; the phrases "fluff" and "real talk"; generic hashtags like #realtorlife.

Do: 1–2 punchy sentences per caption; specific hashtags; a call to action only when it feels natural ("DM me for the numbers", "Hit me up if this is your lane"). Phrases Derek likes: "Here's what most people don't think about…", "Run the numbers. If it works, cool. If not, next.", "Not trying to sell you, just showing you what's out there.", "Here's the move if you want to stay ahead."

Listings: paraphrase the listing in owner-friendly language (yard, layout, kitchen, location, schools), clean and confident, no investment projections unless asked. Post the flyer first, share it to Stories with the link, then follow with video, and add everything to the LISTINGS highlight (flyer first). Derek approves the first post of each listing before the rest is queued.
Sold listings: the story of the client (worked with them for years, helped with a lease, finally homeowners), not how fast it moved.
Meetup recaps: more inviting. Thank the people who showed up, the photographer (@zabemedia) and the sponsors; invite the @austininvestmentmeetups page to collaborate.
Agent recruiting: "This brokerage's not for babysitting — it's for agents ready to build."`;

const AIM: Brand = {
  key: 'aim',
  name: 'Austin Investment Meetup',
  mark: 'AI',
  subtitle: 'Austin Investment Meetup · Deal Smith Realty',
  socialName: 'Austin Investment Meetup',
  videoBrand: 'AIM',
  libraryTitle: 'AIM Video Library',
  libraryBlurb: 'Every AIM recording and reel from the Drive folder, its YouTube title and playlist, and what it still needs before upload.',
  libraryCampaignSlug: 'aim-library',
  categories: [
    'AIM Meetup', 'Meetup Recap', 'Speaker', 'Member Spotlight', 'Education', 'Listing', 'Sold', 'Testimonial',
    'Agent Recruiting', 'Engagement', 'Event', 'Holiday', 'General',
  ],
  campaigns: [
    {
      slug: 'aim-library',
      name: 'AIM Video Library',
      description: 'Austin Investment Meetup recordings, speaker interviews and reels from the DS Docs & Content Assets Drive folder.',
      target_count: null,
      lead_magnet_name: null,
      cta_text: 'Register for the next Austin Investment Meetup.',
    },
    {
      slug: 'aim-30-day',
      name: 'AIM 30-day content plan',
      description: 'The 30-day AIM plan (Week 1 curiosity and authority, Week 2 education, Week 3 social proof, Week 4 event push) from the "AIM Content Ideas" doc.',
      target_count: 30,
      lead_magnet_name: null,
      cta_text: 'Register for the next AIM meetup.',
    },
    {
      slug: 'dsr-october-2026',
      name: 'DSR October 2026 calendar',
      description: 'The revised 30-day October 2026 calendar for Deal Smith Realty and AIM (Education 10, AIM 5, Agent 4, Market 3, Brand 3, Client/listing 3, Humor 2). Black background, gold and white type.',
      target_count: 30,
      lead_magnet_name: null,
      cta_text: 'DM me for the numbers.',
    },
    { slug: 'dsr-listings', name: 'Deal Smith Realty listings', description: 'Listing flyers, Stories and follow-up videos in the order the SOP sets: flyer, Stories with the link, then video.', target_count: null, lead_magnet_name: null, cta_text: 'DM me for the full breakdown.' },
    { slug: 'dsr-recruiting', name: 'Agent recruiting', description: 'Deal Smith Realty agent recruiting posts.', target_count: null, lead_magnet_name: null, cta_text: 'DM if you want in.' },
  ],
  disclaimer: 'Deal Smith Realty, Austin TX. Not financial or legal advice; run your own numbers.',
  metaBusiness: 'Deal Smith Realty’s Business (Derek Smith)',
  canvaTeam: 'Deal Smith Realty Canva account',
  youtubeOwner: 'the account that owns the Austin Investment Meetup channel',
  voice: AIM_VOICE,
};

export const BRANDS: Record<Brand['key'], Brand> = { ceshker: CESHKER, aim: AIM };
export const BRAND_KEYS = Object.keys(BRANDS) as Brand['key'][];

/** The fields the front end needs (no secrets, safe to serve before sign-in). */
export type PublicBrand = Pick<Brand, 'key' | 'name' | 'mark' | 'subtitle' | 'socialName' | 'videoBrand' | 'libraryTitle' | 'libraryBlurb' | 'voice'>;
export function publicBrand(b: Brand): PublicBrand {
  const { key, name, mark, subtitle, socialName, videoBrand, libraryTitle, libraryBlurb, voice } = b;
  return { key, name, mark, subtitle, socialName, videoBrand, libraryTitle, libraryBlurb, voice };
}
