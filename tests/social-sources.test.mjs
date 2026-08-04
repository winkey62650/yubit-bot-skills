import assert from "node:assert/strict";
import test from "node:test";
import {
  detectSocialPlatform,
  normalizeSocialPackages,
  parseXReaderTimeline,
  parseXProfileTimeline,
  parseSocialFeed,
  parseXSyndicationTimeline,
  socialFetchPlan,
  summarizeSocialSources
} from "../lib/social-sources.mjs";

test("social source configuration keeps X and YouTube fields needed by the crawler", () => {
  const packages = normalizeSocialPackages([
    {
      name: "Ricky X",
      agent: "Ricky",
      platform: "Twitter / X",
      accountUrl: "https://x.com/ricky",
      feedUrl: "https://feeds.example.com/ricky.xml",
      status: "已启用"
    },
    {
      name: "Ricky YouTube",
      agent: "Ricky",
      accountUrl: "https://www.youtube.com/channel/UC1234567890",
      status: "已暂停"
    }
  ]);

  assert.equal(packages[0].platform, "X");
  assert.equal(packages[0].feedUrl, "https://feeds.example.com/ricky.xml");
  assert.equal(packages[0].bot, "SpeakerBot");
  assert.equal(packages[1].platform, "YouTube");
  assert.equal(packages[1].frequency, "每小时");
});

test("legacy paused sources stay paused instead of becoming active during migration", () => {
  const [source] = normalizeSocialPackages([
    { name: "Legacy X", agent: "Ricky", platform: "Twitter / X", accountUrl: "https://x.com/ricky", status: "待接入" }
  ]);
  assert.equal(source.status, "已暂停");
});

test("platform detection and fetch plans choose stable sources first", () => {
  assert.equal(detectSocialPlatform("https://twitter.com/agent"), "X");
  assert.equal(detectSocialPlatform("https://youtube.com/@agent"), "YouTube");

  assert.deepEqual(
    socialFetchPlan({ platform: "X", accountUrl: "https://x.com/agent", feedUrl: "https://rss.example.com/agent" }, { hasXToken: false }),
    { kind: "feed", url: "https://rss.example.com/agent", reliability: "stable" }
  );
  assert.deepEqual(
    socialFetchPlan({ platform: "YouTube", accountUrl: "https://youtube.com/channel/UCabc" }),
    { kind: "youtube-feed", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCabc", reliability: "stable" }
  );
  assert.equal(socialFetchPlan({ platform: "X", accountUrl: "https://x.com/agent" }, { hasXToken: true }).kind, "x-api");
  assert.deepEqual(
    socialFetchPlan({ platform: "X", accountUrl: "https://x.com/agent" }, { hasXToken: false }),
    {
      kind: "x-profile",
      username: "agent",
      url: "https://x.com/agent",
      reliability: "standard"
    }
  );
});

test("X public profile parser selects the newest top-level account post", () => {
  const html = `
    <article data-tweet-id="100" itemScope="" itemType="https://schema.org/SocialMediaPosting">
      <meta content="100" itemProp="identifier"/>
      <meta content="2026-08-01T08:00:00.000Z" itemProp="datePublished"/>
      <meta content="https://x.com/JennaXCrypto/status/100" itemProp="url"/>
      <meta content="Pinned older post" itemProp="articleBody"/>
      <meta content="JennaXCrypto" itemProp="alternateName"/>
      <article data-tweet-id="9999999999999999999"><meta content="Quoted post" itemProp="articleBody"/></article>
    </article>
    <article itemType="https://schema.org/SocialMediaPosting" data-tweet-id="2084476005536743718">
      <meta itemProp="identifier" content="2084476005536743718"/>
      <meta itemProp="datePublished" content="2026-08-04T03:06:22.000Z"/>
      <meta itemProp="url" content="https://x.com/JennaXCrypto/status/2084476005536743718"/>
      <meta itemProp="articleBody" content="Coffee &amp; markets ☕️"/>
      <meta itemProp="alternateName" content="JennaXCrypto"/>
    </article>`;

  assert.deepEqual(parseXProfileTimeline(html, "JennaXCrypto"), {
    externalId: "2084476005536743718",
    title: "Coffee & markets ☕️",
    description: "Coffee & markets ☕️",
    url: "https://x.com/JennaXCrypto/status/2084476005536743718",
    publishedAt: "2026-08-04T03:06:22.000Z"
  });
});

test("X reader fallback selects the newest account post and ignores pinned or quoted posts", () => {
  const markdown = `
* Pinned [Jenna](https://x.com/JennaXCrypto) [@JennaXCrypto](https://x.com/JennaXCrypto) [Aug 1](https://x.com/JennaXCrypto/status/2083552295225045247) Pinned older post [![Image 1](https://pbs.twimg.com/old.jpg)](https://x.com/JennaXCrypto/status/2083552295225045247/photo/1)
* [Jenna](https://x.com/JennaXCrypto) [@JennaXCrypto](https://x.com/JennaXCrypto) [3h](https://x.com/JennaXCrypto/status/2084476005536743718) Coffee with [@Markets](https://x.com/Markets) & conviction ☕️ [![Image 2](https://pbs.twimg.com/new.jpg)](https://x.com/JennaXCrypto/status/2084476005536743718/photo/1)
* [Jenna](https://x.com/JennaXCrypto) [@JennaXCrypto](https://x.com/JennaXCrypto) [Aug 3](https://x.com/JennaXCrypto/status/2084083353775468832) My update [Other](https://x.com/Other) [Aug 4](https://x.com/Other/status/9999999999999999999) Quoted post
`;

  assert.deepEqual(parseXReaderTimeline(markdown, "JennaXCrypto"), {
    externalId: "2084476005536743718",
    title: "Coffee with @Markets & conviction ☕️",
    description: "Coffee with @Markets & conviction ☕️",
    url: "https://x.com/JennaXCrypto/status/2084476005536743718",
    publishedAt: "2026-08-04T03:06:22.068Z"
  });
});

test("X reader fallback accepts mobile Twitter links and normalizes them to X", () => {
  const markdown = `
* Pinned [Jenna](https://mobile.twitter.com/JennaXCrypto) [Aug 1](https://mobile.twitter.com/JennaXCrypto/status/2083552295225045247) Pinned older post
* [Jenna](https://mobile.twitter.com/JennaXCrypto) [3h](https://mobile.twitter.com/JennaXCrypto/status/2084476005536743718) You know you’re locked in when you make coffee at 11pm ☕️⚰️
* [Jenna](https://mobile.twitter.com/JennaXCrypto) [Aug 3](https://mobile.twitter.com/JennaXCrypto/status/2084083353775468832) My update [Other](https://mobile.twitter.com/Other/status/9999999999999999999) Quoted post
`;

  assert.deepEqual(parseXReaderTimeline(markdown, "JennaXCrypto"), {
    externalId: "2084476005536743718",
    title: "You know you’re locked in when you make coffee at 11pm ☕️⚰️",
    description: "You know you’re locked in when you make coffee at 11pm ☕️⚰️",
    url: "https://x.com/JennaXCrypto/status/2084476005536743718",
    publishedAt: "2026-08-04T03:06:22.068Z"
  });
});

test("X public timeline parser selects the newest original account post", () => {
  const payload = {
    props: {
      pageProps: {
        timeline: {
          entries: [
            {
              entry_id: "tweet-100",
              content: {
                tweet: {
                  id_str: "100",
                  created_at: "Mon Jul 27 01:00:00 +0000 2026",
                  full_text: "Pinned older post",
                  permalink: "/JennaXCrypto/status/100",
                  user: { screen_name: "JennaXCrypto" }
                }
              }
            },
            {
              entry_id: "tweet-2083552295225045247",
              content: {
                tweet: {
                  id_str: "2083552295225045247",
                  created_at: "Sat Aug 01 08:30:00 +0000 2026",
                  full_text: "Latest Jenna market update",
                  permalink: "/JennaXCrypto/status/2083552295225045247",
                  user: { screen_name: "JennaXCrypto" }
                }
              }
            },
            {
              entry_id: "tweet-9999999999999999999",
              content: {
                tweet: {
                  id_str: "9999999999999999999",
                  created_at: "Sun Aug 02 08:30:00 +0000 2026",
                  full_text: "Another account",
                  permalink: "/OtherAccount/status/9999999999999999999",
                  user: { screen_name: "OtherAccount" }
                }
              }
            }
          ]
        }
      }
    }
  };
  const html = `<html><script type="application/json" id="__NEXT_DATA__">${JSON.stringify(payload)}</script></html>`;

  assert.deepEqual(parseXSyndicationTimeline(html, "JennaXCrypto"), {
    externalId: "2083552295225045247",
    title: "Latest Jenna market update",
    description: "Latest Jenna market update",
    url: "https://x.com/JennaXCrypto/status/2083552295225045247",
    publishedAt: "Sat Aug 01 08:30:00 +0000 2026"
  });
});

test("RSS and YouTube Atom feeds produce one stable latest-content snapshot", () => {
  const rss = `<?xml version="1.0"?><rss><channel><item><guid>tweet-42</guid><title>Latest market note</title><link>https://x.com/agent/status/42</link><description>Risk appetite improved.</description><pubDate>Tue, 14 Jul 2026 08:00:00 GMT</pubDate></item></channel></rss>`;
  const atom = `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><entry><yt:videoId>video-7</yt:videoId><title>Weekly outlook</title><link rel="alternate" href="https://www.youtube.com/watch?v=video-7"/><published>2026-07-14T09:00:00+00:00</published><media:group><media:description>BTC and macro levels.</media:description></media:group></entry></feed>`;

  assert.deepEqual(parseSocialFeed(rss), {
    externalId: "tweet-42",
    title: "Latest market note",
    description: "Risk appetite improved.",
    url: "https://x.com/agent/status/42",
    publishedAt: "Tue, 14 Jul 2026 08:00:00 GMT"
  });
  assert.deepEqual(parseSocialFeed(atom), {
    externalId: "video-7",
    title: "Weekly outlook",
    description: "BTC and macro levels.",
    url: "https://www.youtube.com/watch?v=video-7",
    publishedAt: "2026-07-14T09:00:00+00:00"
  });
});

test("source summary exposes enabled, X and YouTube counts for the UI", () => {
  const summary = summarizeSocialSources([
    { status: "已启用", platform: "X" },
    { status: "已启用", platform: "YouTube" },
    { status: "已暂停", platform: "X" }
  ]);
  assert.deepEqual(summary, { total: 3, enabled: 2, x: 2, youtube: 1 });
});
