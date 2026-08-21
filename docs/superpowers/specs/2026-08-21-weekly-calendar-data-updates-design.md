# Weekly Calendar and Data Updates Editorial Product Design

**Date:** 2026-08-21

**Status:** Design complete; awaiting written-spec approval

**Scope:** Yubit Academy website, Telegram community entry posts, and generated editorial graphics

## 1. Goal

Upgrade Weekly Calendar and Data Updates from utility-style automated posts into source-transparent, commercially publishable editorial products at the same quality level as the approved Market News format.

The products must help a community reader answer four questions quickly:

1. What matters now?
2. Why does it matter for crypto markets?
3. What confirms or invalidates the current interpretation?
4. Where can the reader find the complete analysis and supporting sources?

## 2. Product Principles

- Market impact determines priority. Chronology alone does not determine placement.
- Facts, consensus expectations, observed market reactions, and editorial inference must be visibly separated.
- Official releases are authoritative for scheduled times and actual values.
- Every published conclusion must have traceable source metadata.
- Missing or conflicting evidence reduces certainty or blocks publication; it must never be filled with invented values.
- Telegram is the entry point. The website is the durable home for complete analysis.
- Visual polish supports comprehension and trust; it does not replace rigorous content.

## 3. Non-goals

- This design does not turn every macroeconomic release into a long article.
- This design does not provide personalized investment advice or price targets.
- This design does not authorize publishing to Telegram, pushing to GitHub, or deploying to production.
- This design does not replace Market News. It defines the two adjacent products that complete the editorial system.

## 4. Product Architecture

The editorial system contains three complementary products:

| Product | Reader question | Primary output |
| --- | --- | --- |
| Market News | What changed the market narrative today? | Daily analysis article and community brief |
| Weekly Calendar | What can move the market this week? | Weekly risk playbook, calendar graphic, and community brief |
| Data Updates | What did the release change after publication? | Release card, reaction analysis, and tier-dependent article |

Weekly Calendar is the pre-event planning product. Data Updates is the post-event interpretation product. They should share terminology, provenance rules, visual language, and confirmation/invalidation logic.

## 5. Weekly Calendar Content Contract

### 5.1 Community entry post

The Telegram entry is written in English and follows a stable structure:

```text
📌 Weekly Market Calendar — {week range}

Core view: {one-sentence assessment of the week's dominant market risk}

The three events that matter most
1. {event and timing} — {why it matters and the primary transmission path}
2. {event and timing} — {why it matters and the primary transmission path}
3. {event and timing} — {why it matters and the primary transmission path}

Confirmation: {observable conditions that confirm the base case}.
Invalidation: {observable conditions that overturn the base case}.

Read the full weekly playbook → {public article URL}
```

The brief must not exceed what can be read comfortably in Telegram without opening a separate document. Only the three highest-impact events appear in the numbered section.

### 5.2 Website article

The weekly article is a risk playbook rather than a list of timestamps. It contains:

1. **Core view:** the week's dominant macro, liquidity, policy, or crypto-native risk.
2. **Market setup:** positioning and market conditions entering the week, with observation times.
3. **Impact-ranked event table:** date, time, event, jurisdiction, expected value when available, prior value, affected assets, source status, and impact tier.
4. **Tier-one event analysis:** why each event matters, consensus interpretation, upside and downside surprise scenarios, and the transmission path through rates, DXY, equities, BTC, and ETH where supported.
5. **Scenario framework:** base, strengthening, and invalidation scenarios with observable conditions.
6. **Daily watchlist:** a concise checklist for each active trading day.
7. **Source notes:** official calendar links, auxiliary expectation sources, market-data providers, timestamps, and known limitations.

Statements about positioning or market reaction must include the measurement timestamp or observation window. If a required signal is unavailable, the article states that the signal is unavailable rather than substituting narrative confidence.

### 5.3 Calendar graphic

The weekly image uses the approved **Editorial Research** direction:

- Warm gray editorial-paper background.
- Restrained black, charcoal, muted red, and muted green palette.
- Generous whitespace and a publication-style typographic hierarchy.
- Five weekday columns as the primary layout.
- A separate `Crypto Weekend` section only when material Saturday or Sunday events exist.
- Impact tiers are communicated through compact labels and accent rules, not decorative effects.
- The top three events receive greater visual weight than secondary events.
- Footer includes source summary, timezone, data timestamp, and the Yubit Academy identifier.

The production canvas is 1200×675 and must remain legible in Telegram's mobile preview.

## 6. Data Updates Content Contract

### 6.1 Release tiers

Data Updates uses two publication levels.

**Tier one releases** include CPI, Core CPI, PCE, Core PCE, Nonfarm Payrolls, unemployment, FOMC rate decisions and material guidance, GDP, and other releases explicitly promoted by the impact-ranking policy. Tier-one releases generate:

- A 1200×675 data card.
- An English Telegram community entry.
- A complete website reaction article.

**Secondary releases** generate:

- A 1200×675 data card when the evidence is sufficient.
- A short English interpretation.
- No standalone website article.

The impact-ranking policy may promote or demote an event based on current market sensitivity, but the decision and its inputs must be recorded.

### 6.2 Tier-one community entry post

```text
📌 Data Update — {release name} | {release date}

Core read: {one-sentence interpretation of the result and initial market confirmation}

What changed
1. Actual: {actual} vs. {forecast} expected; previous: {previous}.
2. Surprise: {measured difference and direction, without overstating significance}.
3. Market reaction: {time-bounded reaction across the available relevant assets}.

Confirmation: {conditions that validate the interpretation}.
Invalidation: {conditions that invalidate or materially weaken it}.

Read the full analysis → {public article URL}
```

If no reputable forecast is available, the forecast comparison and surprise language are omitted. The post may compare with the previous value but must not imply a consensus surprise.

### 6.3 Tier-one website article

The complete reaction article answers these questions in order:

1. What was released?
2. How did the actual value compare with a sourced expectation and the prior value?
3. Why was this release important under the current market regime?
4. How did rates, DXY, equities, BTC, and ETH react within clearly specified observation windows?
5. Did the reaction confirm the data signal, contradict it, or remain inconclusive?
6. What should readers monitor next?
7. What evidence would invalidate the interpretation?

The article contains a compact fact table, a `Data Signal` section, a separate `Market Confirmation` section, scenario analysis, and source notes. A statement such as “CPI caused BTC to fall” is prohibited unless the article describes the evidence and limitations; the preferred wording reports temporal reaction and treats causal interpretation as an inference.

### 6.4 Data card

The data card uses the same Editorial Research visual system and includes:

- Release title, jurisdiction, publication time, and impact tier.
- Actual, forecast when available, previous, and calculated surprise.
- Initial reaction values for relevant supported assets.
- An explicit verdict: `Confirmed`, `Divergent`, or `Awaiting Confirmation`.
- Confirmation and invalidation conditions.
- Official source, market-data source summary, reaction window, and update timestamp.

## 7. Source and Provenance Design

### 7.1 Source hierarchy

The system maintains at least three free retrieval paths for each information category, while authority is determined by source type rather than majority vote.

For economic schedules and actual releases:

1. Official institutions such as BLS, BEA, Federal Reserve, ECB, and equivalent agencies.
2. Independent free calendar or structured-data source.
3. A second independent free calendar or structured-data source.

For market reactions:

1. A direct exchange market-data API for supported crypto pairs.
2. A second direct exchange or independent market-data API.
3. A free aggregator as cross-check and fallback.

Exact providers are confirmed during implementation from currently working adapters and their terms. Provider availability does not change the rule that official actual values outrank all republished values.

### 7.2 Provenance record

Every normalized event or release stores:

- Provider and source type.
- Source URL or stable source identifier.
- Retrieved-at timestamp.
- Source publication timestamp when available.
- Event timezone and normalized UTC time.
- Raw value, normalized value, and unit.
- Whether the value is official, auxiliary, cached, or conflicting.
- The comparison sources used for verification.

Generated documents retain the source identifiers used for each factual field so the website and image footer can display appropriate attribution.

### 7.3 Conflict rules

- Official institution data wins for exact release times and actual values.
- A free calendar may supply consensus expectations, but expectations must be labeled as consensus or provider estimates.
- If two official representations conflict, the field is marked conflicting and automatic publication is blocked until resolved.
- If auxiliary sources disagree on a forecast, the product either displays the named provider's forecast or omits the forecast. It never averages incompatible figures silently.
- Missing units, ambiguous timezones, or stale values are treated as validation failures.

## 8. Degradation and Fail-closed Rules

| Condition | Weekly Calendar behavior | Data Update behavior |
| --- | --- | --- |
| Primary official source unavailable | Use verified cache with stale label, then cross-check two auxiliary paths | Wait for official actual; do not publish full release analysis |
| Scheduled time conflicts | Mark `Time under verification` and exclude from top-three brief | Block automatic post until resolved |
| Consensus forecast unavailable | Show event without forecast | Omit forecast and surprise claims |
| Official actual unavailable | Not applicable before release | Block tier-one article and community entry |
| Market reaction incomplete | Publish planning analysis without reaction claims | Use `Awaiting Confirmation`; avoid causal verdict |
| One market API unavailable | Use the remaining verified routes and record degradation | Same, provided the reaction window can still be reconstructed |
| Public article URL fails health check | Do not include or distribute the entry post | Do not distribute the entry post |

Cached calendar data may be used only when its age is visible and within the configured tolerance. Cached actual release values never override a newer official result.

## 9. Routes, Persistence, and Distribution

Canonical routes are:

- Weekly Calendar: `/market-calendar/{ISO-year}-W{ISO-week}`
- Tier-one Data Update: `/data-updates/{release-slug}/{YYYY-MM-DD}`

The publishing transaction follows this order:

1. Collect and normalize source records.
2. Validate authority, freshness, units, timezones, and conflicts.
3. Rank impact and build the editorial model.
4. Persist the article and source metadata locally.
5. Render and persist the image asset locally.
6. Verify the website page and asset through a public health check.
7. Create the Telegram entry with the verified public URL.
8. Send only after the configured release gate is explicitly enabled.

A failure before step 6 prevents Telegram distribution. Retrying distribution must use an idempotency key tied to product type, event or week, language, target group, and topic so a retry cannot create duplicate posts.

## 10. Editorial and Safety Rules

- Published language is English unless a channel configuration explicitly requests another language.
- Numerical claims include units and do not imply false precision.
- `Forecast`, `Actual`, `Previous`, `Observed Reaction`, and `Editorial View` are distinct semantic fields.
- The copy avoids guaranteed outcomes, unsupported superlatives, and direct trading instructions.
- Confirmation and invalidation conditions must be observable rather than rhetorical.
- Articles include a short informational-purpose disclaimer without weakening the main editorial thesis.

## 11. Acceptance Criteria

### 11.1 Content quality

- Weekly output contains a core view, exactly three priority events in the community brief, transmission paths, confirmation, invalidation, and a verified article link.
- Every tier-one update contains sourced actual data, prior data when available, forecast only when sourced, a bounded reaction window, market-confirmation status, confirmation, invalidation, and a verified article link.
- Secondary releases cannot accidentally generate a standalone article.
- Facts, market observations, and inference are structurally distinguishable.

### 11.2 Source resilience

- Each source category has at least three configured free retrieval paths.
- Tests cover primary-source failure, stale cache, timezone conflict, unit conflict, missing forecast, missing official actual, and partial market-data failure.
- No test fixture permits an invented forecast or actual value.
- Each rendered product exposes source and update metadata appropriate to its format.

### 11.3 Visual quality

- Calendar and data-card images render at 1200×675.
- Images remain readable in a mobile Telegram preview.
- Long event names, missing forecasts, negative values, and multiple timezones do not break the layout.
- The Editorial Research direction is consistent across both formats.

### 11.4 Engineering and release gate

- Targeted unit tests pass.
- Full automated tests pass.
- Static checks pass.
- Production build passes.
- Local dry-run produces the website article, graphic, and community brief without external distribution.
- No GitHub push, production deployment, or Telegram send occurs without separate explicit approval.

## 12. Ownership

| Owner | Responsibility | Acceptance responsibility |
| --- | --- | --- |
| Jobs | Product definition and final product coherence | Confirms the three products form one usable editorial system |
| MaYun | Editorial templates, hierarchy, and channel usability | Confirms commercial-quality copy and community entry discipline |
| LeiJun | Source adapters, normalization, persistence, routes, and reliability | Confirms provenance, degradation, and idempotency behavior |
| Musk | Editorial Research visual implementation and responsive pages | Confirms visual hierarchy and Telegram readability |
| Trump | Test coverage, source-failure scenarios, and release gate | Blocks release when evidence or verification is incomplete |

## 13. Implementation Boundary

Implementation begins only after this written specification is reviewed and approved. The next artifact is an implementation plan that maps the design onto existing modules, tests, migrations, routes, and verification commands. External publishing and deployment remain separate, explicitly authorized release steps.
