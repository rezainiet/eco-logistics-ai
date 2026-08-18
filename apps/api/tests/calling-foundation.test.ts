import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  AuditLog,
  CallEvent,
  CallSession,
  CallingExtension,
  CallingNumber,
  MerchantUser,
  Usage,
  currentUsagePeriod,
} from "@ecom/db";
import { writeAudit } from "../src/lib/audit.js";
import { quotaFor } from "../src/lib/plans.js";
import { PLANS } from "@ecom/types";
import { authUserFor, callerFor, createMerchant, disconnectDb, resetDb } from "./helpers.js";

describe("provider-neutral calling foundation", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("creates merchant agents and keeps them tenant-scoped", async () => {
    const merchant = await createMerchant();
    const other = await createMerchant({ email: `other-${Date.now()}@test.com` });
    const caller = callerFor(authUserFor(merchant));

    const agent = await caller.callingFoundation.createAgent({
      email: "agent@example.com",
      name: "Agent One",
      role: "agent",
      status: "active",
    });

    expect(agent.id).toBeTruthy();
    expect(agent.role).toBe("agent");
    await expect(
      caller.callingFoundation.createAgent({ email: "agent@example.com" }),
    ).rejects.toThrow(/already exists/i);

    const ownAgents = await caller.callingFoundation.listAgents();
    expect(ownAgents.map((a) => a.email)).toEqual(["agent@example.com"]);
    const otherAgents = await callerFor(authUserFor(other)).callingFoundation.listAgents();
    expect(otherAgents).toHaveLength(0);

    const stored = await MerchantUser.findOne({ merchantId: merchant._id }).lean();
    expect(stored?.email).toBe("agent@example.com");
  });

  it("assigns extensions only to agents owned by the same merchant", async () => {
    const merchant = await createMerchant();
    const other = await createMerchant({ email: `other-${Date.now()}@test.com` });
    const caller = callerFor(authUserFor(merchant));
    const otherCaller = callerFor(authUserFor(other));
    const agent = await caller.callingFoundation.createAgent({ email: "agent@example.com" });

    const ext = await caller.callingFoundation.createExtension({
      extension: "1001",
      assignedUserId: agent.id,
    });

    expect(ext.extension).toBe("1001");
    expect(ext.assignedUserId).toBe(agent.id);
    await expect(
      caller.callingFoundation.createExtension({ extension: "1001" }),
    ).rejects.toThrow(/already exists/i);
    await expect(
      caller.callingFoundation.createExtension({ extension: "1002", assignedUserId: agent.id }),
    ).rejects.toThrow(/already exists|already assigned/i);
    await expect(
      otherCaller.callingFoundation.createExtension({
        extension: "1001",
        assignedUserId: agent.id,
      }),
    ).rejects.toThrow(/agent not found/i);

    const stored = await CallingExtension.findOne({ merchantId: merchant._id }).lean();
    expect(stored?.extension).toBe("1001");
  });

  it("creates merchant-owned business numbers with normalized global uniqueness", async () => {
    const merchant = await createMerchant();
    const other = await createMerchant({ email: `other-${Date.now()}@test.com` });
    const caller = callerFor(authUserFor(merchant));
    const otherCaller = callerFor(authUserFor(other));

    const number = await caller.callingFoundation.createBusinessNumber({
      phoneNumber: "09638000001",
      providerKey: "local_pbx",
      providerNumberId: "num-1",
    });

    expect(number.normalizedPhone).toBe("+8809638000001");
    await expect(
      otherCaller.callingFoundation.createBusinessNumber({ phoneNumber: "+8809638000001" }),
    ).rejects.toThrow(/already exists/i);

    const ownNumbers = await caller.callingFoundation.listBusinessNumbers();
    expect(ownNumbers).toHaveLength(1);
    const otherNumbers = await otherCaller.callingFoundation.listBusinessNumbers();
    expect(otherNumbers).toHaveLength(0);

    const stored = await CallingNumber.findOne({ normalizedPhone: "+8809638000001" }).lean();
    expect(String(stored?.merchantId)).toBe(String(merchant._id));
  });

  it("creates outbound and inbound sessions with server-side ownership checks", async () => {
    const merchant = await createMerchant();
    const other = await createMerchant({ email: `other-${Date.now()}@test.com` });
    const caller = callerFor(authUserFor(merchant));
    const otherCaller = callerFor(authUserFor(other));
    const agent = await caller.callingFoundation.createAgent({ email: "agent@example.com" });
    const ext = await caller.callingFoundation.createExtension({
      extension: "1001",
      assignedUserId: agent.id,
    });
    const number = await caller.callingFoundation.createBusinessNumber({
      phoneNumber: "+8809638000002",
    });

    const outbound = await caller.callingFoundation.createCallSession({
      direction: "outbound",
      agentUserId: agent.id,
      extensionId: ext.id,
      businessNumberId: number.id,
      customerPhone: "01711111111",
      providerKey: "local_pbx",
      providerCallId: "call-out-1",
    });
    const inbound = await caller.callingFoundation.createCallSession({
      direction: "inbound",
      extensionId: ext.id,
      businessNumberId: number.id,
      customerPhone: "+8801711111112",
    });

    expect(outbound.reservedCallMinutes).toBe(1);
    expect(inbound.reservedCallMinutes).toBe(0);
    await expect(
      otherCaller.callingFoundation.createCallSession({
        direction: "outbound",
        extensionId: ext.id,
      }),
    ).rejects.toThrow(/extension not found/i);
    await expect(
      otherCaller.callingFoundation.getCallSession({ callSessionId: outbound.id }),
    ).rejects.toThrow(/call session not found/i);
  });

  it("enforces valid call state transitions", async () => {
    const merchant = await createMerchant();
    const caller = callerFor(authUserFor(merchant));
    const session = await caller.callingFoundation.createCallSession({ direction: "inbound" });

    const answered = await caller.callingFoundation.transitionCallSession({
      callSessionId: session.id,
      status: "answered",
    });
    expect(answered.status).toBe("answered");

    const completed = await caller.callingFoundation.transitionCallSession({
      callSessionId: session.id,
      status: "completed",
      durationSeconds: 61,
    });
    expect(completed.status).toBe("completed");

    await expect(
      caller.callingFoundation.transitionCallSession({
        callSessionId: session.id,
        status: "ringing",
      }),
    ).rejects.toThrow(/terminal|invalid/i);
  });

  it("deduplicates call events and does not double-count usage", async () => {
    const merchant = await createMerchant();
    const caller = callerFor(authUserFor(merchant));
    const session = await caller.callingFoundation.createCallSession({
      direction: "outbound",
      providerKey: "local_pbx",
      providerCallId: "provider-call-1",
    });

    const first = await caller.callingFoundation.processCallEvent({
      callSessionId: session.id,
      providerKey: "local_pbx",
      providerEventId: "evt-answered-1",
      eventType: "completed",
      durationSeconds: 125,
      payload: { providerStatus: "completed" },
    });
    const duplicate = await caller.callingFoundation.processCallEvent({
      callSessionId: session.id,
      providerKey: "local_pbx",
      providerEventId: "evt-answered-1",
      eventType: "completed",
      durationSeconds: 125,
      payload: { providerStatus: "completed" },
    });

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(await CallEvent.countDocuments({ merchantId: merchant._id })).toBe(1);

    const storedSession = await CallSession.findById(session.id).lean();
    expect(storedSession?.durationSeconds).toBe(125);
    expect(storedSession?.billedMinutes).toBe(3);
    const usage = await Usage.findOne({ merchantId: merchant._id }).lean();
    expect(usage?.callsInitiated).toBe(1);
    expect(usage?.callMinutesUsed).toBe(3);
  });

  it("releases reserved call minutes for failed or missed outbound calls", async () => {
    const merchant = await createMerchant();
    const caller = callerFor(authUserFor(merchant));
    const session = await caller.callingFoundation.createCallSession({ direction: "outbound" });

    let usage = await Usage.findOne({ merchantId: merchant._id }).lean();
    expect(usage?.callMinutesUsed).toBe(1);

    await caller.callingFoundation.processCallEvent({
      callSessionId: session.id,
      providerKey: "local_pbx",
      providerEventId: "evt-failed-1",
      eventType: "failed",
      failureCode: "NO_ROUTE",
      failureReason: "No route available",
    });

    usage = await Usage.findOne({ merchantId: merchant._id }).lean();
    expect(usage?.callsInitiated).toBe(1);
    expect(usage?.callMinutesUsed).toBe(0);
  });

  it("blocks outbound call sessions only when call-minute quota is exhausted", async () => {
    const merchant = await createMerchant({ tier: "starter" });
    const caller = callerFor(authUserFor(merchant));
    await Usage.create({
      merchantId: merchant._id,
      period: currentUsagePeriod(),
      callsInitiated: 999,
      callMinutesUsed: 60,
    });

    expect(quotaFor(PLANS.starter, "callsInitiated")).toBeNull();
    expect(quotaFor(PLANS.starter, "callMinutesUsed")).toBe(60);
    await expect(
      caller.callingFoundation.createCallSession({ direction: "outbound" }),
    ).rejects.toThrow(/call minute quota reached/i);
  });

  it("records pii.read audit rows without storing raw sensitive phone data", async () => {
    const merchant = await createMerchant();

    await writeAudit({
      merchantId: merchant._id,
      actorId: merchant._id,
      actorEmail: merchant.email,
      action: "pii.read",
      subjectType: "merchant",
      subjectId: merchant._id,
      meta: {
        source: "orders.getOrder",
        fields: ["customer.phone", "customer.address"],
      },
    });

    const row = await AuditLog.findOne({ action: "pii.read" }).lean();
    expect(row).toBeTruthy();
    expect(row?.meta).toMatchObject({
      source: "orders.getOrder",
      fields: ["customer.phone", "customer.address"],
    });
    expect(JSON.stringify(row?.meta)).not.toContain("+880");
  });
});
