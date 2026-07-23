import { NextResponse } from "next/server";
import {
  claimDesktopPublisherDelivery,
  completeDesktopPublisherDelivery
} from "../../../../lib/distribution-service.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function authorized(request) {
  const secret = String(process.env.DESKTOP_PUBLISHER_SECRET || "").trim();
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, job: await claimDesktopPublisherDelivery() });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await request.json();
    if (!body?.deliveryId) {
      return NextResponse.json({ ok: false, error: "deliveryId is required" }, { status: 400 });
    }
    const delivery = await completeDesktopPublisherDelivery(body.deliveryId, {
      status: body.status,
      leaseId: body.leaseId,
      stepId: body.stepId,
      observedGroupName: body.observedGroupName,
      observedTopicName: body.observedTopicName,
      observedSenderName: body.observedSenderName,
      targetMessageId: body.targetMessageId,
      targetMessageIds: body.targetMessageIds,
      error: body.error
    });
    return NextResponse.json({ ok: true, delivery });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }
}
