import { randomBytes } from "node:crypto";
import { z } from "zod";
import { NotFoundError, ValidationError } from "@/lib/shared/errors";
import { siteRepository } from "./site.repository";

const createSiteSchema = z.object({
  name: z.string().trim().min(2, "站点名称至少 2 个字符").max(60),
  domain: z.string().url("请输入完整网址，例如 https://example.com"),
});

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  return slug || `site-${Date.now().toString(36)}`;
}

export const siteService = {
  list() {
    return siteRepository.list();
  },

  get(id: string) {
    const row = siteRepository.findById(id);
    if (!row) throw new NotFoundError("Site");
    return {
      id: row.id,
      name: row.name,
      domain: row.domain,
      apiKey: row.api_key,
      createdAt: row.created_at,
    };
  },

  create(input: unknown) {
    const parsed = createSiteSchema.parse(input);
    const baseId = slugify(new URL(parsed.domain).hostname);
    const id = siteRepository.findById(baseId) ? `${baseId}-${Date.now().toString(36)}` : baseId;
    try {
      return siteRepository.create({
        id,
        name: parsed.name,
        domain: parsed.domain.replace(/\/$/, ""),
        apiKey: `site_${randomBytes(8).toString("hex")}`,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        throw new ValidationError("该域名已经收录");
      }
      throw error;
    }
  },

  archive(id: string) {
    const result = siteRepository.archive(id, new Date().toISOString());
    if (result.changes === 0) throw new NotFoundError("Site");
  },
};
