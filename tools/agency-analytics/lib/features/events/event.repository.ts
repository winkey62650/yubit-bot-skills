import { getDatabase } from "@/lib/shared/database";
import type { EventType } from "@/lib/shared/types";

export type IncomingEvent = {
  siteId: string;
  eventType: EventType;
  anonymousId: string;
  sessionId: string;
  path: string;
  elementId?: string;
  value?: number;
  durationMs: number;
  occurredAt: string;
  userAgent?: string;
  referrer?: string;
};

export const eventRepository = {
  insert(event: IncomingEvent) {
    return getDatabase()
      .prepare(`
        INSERT INTO events
          (site_id, event_type, anonymous_id, session_id, path, element_id, value, duration_ms, occurred_at, user_agent, referrer, is_demo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `)
      .run(
        event.siteId,
        event.eventType,
        event.anonymousId,
        event.sessionId,
        event.path,
        event.elementId || null,
        event.value ?? null,
        event.durationMs,
        event.occurredAt,
        event.userAgent || null,
        event.referrer || null,
      );
  },
};
