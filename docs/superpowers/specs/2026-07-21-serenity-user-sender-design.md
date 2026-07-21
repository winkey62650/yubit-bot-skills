# Serenity Telegram User Sender Design

Date: 2026-07-21
Status: Approved direction

## Goal

Change outbound Telegram delivery so scheduled content, approved trader signals, and broadcasts are published through the Telegram user account `@Serenity_Crypto` instead of directly by a bot, while preserving the existing content templates, topic routing, scheduling, deduplication, and delivery logs.

The local Telegram application is already signed in as `@Serenity_Crypto`. It will be used only to authorize and verify a dedicated server-side MTProto session. Production delivery must continue to run on the server when the local Mac is offline.

## Selected approach

Use a dedicated Telegram user MTProto session on the production server.

The local Telegram application receives or confirms the one-time login authorization. The application must not read, copy, convert, or upload Telegram Desktop session files. The resulting server session is encrypted at rest and is never returned by an API or rendered in the administration UI.

Alternatives rejected:

- Driving the local Telegram GUI for production publishing: this stops when the Mac sleeps, disconnects, changes network, or closes Telegram and cannot satisfy server scheduling reliability.
- Copying Telegram Desktop session files: unsafe, brittle, and grants broader account access than necessary.
- Continuing bot-authenticated MTProto with transferred bot ownership: ownership transfer does not change the sender identity of Bot API or bot-authenticated MTProto messages.

## Sender behavior

- Supergroups and forum topics: send as the logged-in `@Serenity_Crypto` user. The account name and avatar are visible unless Telegram group settings force anonymous administration.
- Broadcast channels: authenticate as `@Serenity_Crypto`, but publish using the target Channel identity by default so subscribers see the Channel name and avatar. A target may explicitly request the user profile only when Telegram returns it from `channels.getSendAs` and Channel signatures/profiles are enabled.
- Bot fallback is prohibited. If the user session is disconnected, unauthorized, or lacks permission, the delivery fails visibly and is retryable after recovery.
- The three bots remain available for discovery, permission checks, inbound webhooks, trader submissions, and administrative commands. They are no longer the outbound sender for rules migrated to the Serenity transport.

## Authorization and secret handling

Add an authenticated administration flow for connecting the Telegram publisher account:

1. An administrator starts a one-time authorization request.
2. The server requests a Telegram login code or QR authorization token.
3. The administrator confirms it with the already logged-in local Telegram application.
4. If two-step verification is required, the administrator enters it directly into the protected authorization UI. It is never logged or stored.
5. The server verifies that the authorized username is exactly `Serenity_Crypto`.
6. The serialized MTProto session is encrypted with a server-only encryption key and persisted.

Security requirements:

- No phone number, login code, two-step verification password, API hash, or session string in client logs, application logs, Git, Telegram chats, or API responses.
- Authorization endpoints require the existing administrator login, short-lived nonces, CSRF protection, attempt limits, and automatic expiry.
- Provide explicit disconnect/revoke and reconnect actions.
- Display only username, Telegram numeric user ID, connection state, last verified time, and safe error summaries.

## Delivery architecture

Introduce a sender adapter with the same message contract currently used by automatic publishing, broadcasts, and trader signals:

- `bot` transport remains available for bot-only administrative operations.
- `telegram-user` transport handles outbound text, photos, videos, files, media groups, replies, captions, and supported edits.
- Rules store their sender mode explicitly. New content distribution rules default to `telegram-user`.
- Existing rules intended for production content are migrated idempotently to `telegram-user` after the account passes health checks.
- The scheduler, content generation, template selection, target `chatId + threadId`, deduplication keys, and per-target retry records remain unchanged.

Every delivery record must include the sender mode, authorized Telegram user ID, effective displayed peer, target chat/thread, Telegram message ID, and safe failure reason.

## Health and operations

The administration UI shows a live publisher status:

- Connected and username verified
- Permission verified for the selected target
- Authorization expired or revoked
- Flood-wait until time
- Target membership or send permission missing

Health checks use MTProto read-only calls and cache results briefly with a visible checked-at time. A stale result is labelled stale rather than shown as online.

Rate limits must serialize bursts per account, honor Telegram flood-wait responses, and avoid automatic retry loops that could be interpreted as spam. Production tasks remain idempotent.

## Acceptance scope

The first real-message acceptance test is restricted to the private `demo channel`. No message may be sent to Fight Club, CryptoGuy Academy, or any other group or Channel until the user explicitly approves expansion.

Acceptance sequence:

1. Connect the server session using the local Telegram application.
2. Verify the server session resolves to `@Serenity_Crypto`.
3. Verify membership, administrator rights, and effective send-as identity for `demo channel`.
4. Send one clearly labelled test text.
5. Send one current production-quality image plus caption using an existing content template.
6. Schedule one short-delay test and confirm it runs while the local Mac is not involved in delivery.
7. Confirm delivery logs, Telegram message IDs, deduplication, and retry behavior.
8. Confirm disabling or revoking the session blocks delivery without bot fallback.

## Release gate

Release requires automated tests for authorization state, encryption boundaries, username mismatch, sender routing, missing permissions, flood-wait behavior, deduplication, and no-bot-fallback. Production is enabled only after the private `demo channel` acceptance passes and the user explicitly approves rollout beyond the demo target.

## References

- Telegram user authorization: https://core.telegram.org/api/auth
- Telegram application credentials: https://core.telegram.org/api/obtaining_api_id
- Telegram send-as behavior: https://core.telegram.org/api/channel#sending-messages-as-other-peers
