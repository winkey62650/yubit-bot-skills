import { z } from "zod";
import { EVENT_TYPES } from "@/lib/shared/types";
import { ForbiddenError, NotFoundError } from "@/lib/shared/errors";
import { siteService } from "@/lib/features/sites/site.service";
import { eventRepository } from "./event.repository";

const eventSchema = z.object({
  siteId: z.string().min(1).max(80),
  key: z.string().min(8).max(100),
  eventType: z.enum(EVENT_TYPES),
  anonymousId: z.string().min(6).max(100),
  sessionId: z.string().min(6).max(100),
  path: z.string().max(500).default("/"),
  elementId: z.string().max(160).optional(),
  value: z.number().finite().optional(),
  durationMs: z.number().int().min(0).max(300_000).default(0),
  occurredAt: z.string().datetime().optional(),
  referrer: z.string().max(1000).optional(),
});

function originMatches(origin: string | null, domain: string) {
  if (!origin) return true;
  if (origin.startsWith("http://127.0.0.1") || origin.startsWith("http://localhost")) return true;
  try {
    return new URL(origin).hostname === new URL(domain).hostname;
  } catch {
    return false;
  }
}

export const eventService = {
  capture(input: unknown, context: { origin: string | null; userAgent: string | null }) {
    const parsed = eventSchema.parse(input);
    let site;
    try {
      site = siteService.get(parsed.siteId);
    } catch {
      throw new NotFoundError("Site");
    }
    if (site.apiKey !== parsed.key) throw new ForbiddenError("Invalid site key");
    if (!originMatches(context.origin, site.domain)) throw new ForbiddenError();

    const result = eventRepository.insert({
      siteId: parsed.siteId,
      eventType: parsed.eventType,
      anonymousId: parsed.anonymousId,
      sessionId: parsed.sessionId,
      path: parsed.path,
      elementId: parsed.elementId,
      value: parsed.value,
      durationMs: parsed.durationMs,
      occurredAt: parsed.occurredAt || new Date().toISOString(),
      userAgent: context.userAgent || undefined,
      referrer: parsed.referrer,
    });
    return { eventId: Number(result.lastInsertRowid) };
  },
};
