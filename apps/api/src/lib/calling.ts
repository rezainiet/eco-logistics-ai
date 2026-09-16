import { Types } from "mongoose";
import {
  CallEvent,
  CallSession,
  CallingExtension,
  CallingNumber,
  CallingProviderAccount,
  MerchantUser,
  type CallSessionStatus,
  type MerchantUserRole,
  type MerchantUserStatus,
} from "@ecom/db";
import { getPlan } from "./plans.js";
import { bumpUsage, releaseQuota, reserveQuota } from "./usage.js";
import { normalizePhone } from "./phone.js";
import { Merchant } from "@ecom/db";
import {
  getLocalPbxClient,
  isLocalPbxConfigured,
  LOCAL_PBX_PROVIDER_KEY,
  type LocalPbxCdrRecord,
} from "./calling/providers/localPbx.js";
import {
  ASTERISK_PROVIDER_KEY,
  agentChannelFor,
  asteriskOutboundContext,
  getAsteriskClient,
  isAsteriskConfigured,
  mapAmiEventToCallEvent,
} from "./calling/providers/asterisk.js";

export class CallingDomainError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "bad_request"
      | "not_found"
      | "conflict"
      | "quota_exhausted"
      | "invalid_transition",
  ) {
    super(message);
  }
}

const TERMINAL_STATUSES = new Set<CallSessionStatus>([
  "completed",
  "failed",
  "missed",
  "cancelled",
]);

const EVENT_STATUS: Record<string, CallSessionStatus> = {
  queued: "queued",
  ringing: "ringing",
  answered: "answered",
  completed: "completed",
  ended: "completed",
  failed: "failed",
  missed: "missed",
  "no-answer": "missed",
  cancelled: "cancelled",
  canceled: "cancelled",
};

const ALLOWED_TRANSITIONS: Record<CallSessionStatus, ReadonlySet<CallSessionStatus>> = {
  created: new Set(["queued", "ringing", "answered", "completed", "failed", "missed", "cancelled"]),
  queued: new Set(["ringing", "answered", "completed", "failed", "missed", "cancelled"]),
  ringing: new Set(["answered", "completed", "failed", "missed", "cancelled"]),
  answered: new Set(["completed", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  missed: new Set(),
  cancelled: new Set(),
};

function asObjectId(value: Types.ObjectId | string, name: string): Types.ObjectId {
  if (value instanceof Types.ObjectId) return value;
  if (!Types.ObjectId.isValid(value)) {
    throw new CallingDomainError(`invalid ${name}`, "bad_request");
  }
  return new Types.ObjectId(value);
}

function duplicateKey(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: number }).code === 11000
  );
}

function billedMinutes(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.ceil(durationSeconds / 60);
}

function localPbxAccountRequired(): void {
  if (!isLocalPbxConfigured()) {
    throw new CallingDomainError("local PBX API is not configured", "bad_request");
  }
}

function cdrEventId(record: LocalPbxCdrRecord): string | null {
  return (
    pickProviderId(record.call_id) ??
    pickProviderId(record.uniqueid) ??
    pickProviderId(record.id) ??
    null
  );
}

function pickProviderId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function cdrDuration(record: LocalPbxCdrRecord): number {
  const raw = record.billsec ?? record.duration ?? 0;
  const value = typeof raw === "string" ? Number(raw) : raw;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function cdrStatus(record: LocalPbxCdrRecord): "completed" | "failed" | "missed" {
  const disposition = String(record.disposition ?? record.status ?? "").trim().toUpperCase();
  if (disposition === "ANSWERED") return "completed";
  if (disposition === "NO ANSWER") return "missed";
  return "failed";
}

async function merchantPlan(merchantId: Types.ObjectId) {
  const merchant = await Merchant.findById(merchantId).select("subscription.tier").lean();
  return getPlan(merchant?.subscription?.tier);
}

export async function upsertCallingProviderAccount(input: {
  merchantId: Types.ObjectId | string;
  providerCustomerId: string;
  providerKey?: string;
  domain?: string;
  status?: "active" | "inactive" | "suspended";
}) {
  const merchantId = asObjectId(input.merchantId, "merchantId");
  const providerKey = (input.providerKey ?? LOCAL_PBX_PROVIDER_KEY).trim().toLowerCase();
  const existingCustomer = await CallingProviderAccount.findOne({
    merchantId: { $ne: merchantId },
    providerKey,
    providerCustomerId: input.providerCustomerId,
  })
    .select("_id")
    .lean();
  if (existingCustomer) {
    throw new CallingDomainError("PBX customer account is already linked", "conflict");
  }
  try {
    return await CallingProviderAccount.findOneAndUpdate(
      { merchantId, providerKey },
      {
        $set: {
          providerCustomerId: input.providerCustomerId,
          domain: input.domain,
          status: input.status ?? "active",
        },
      },
      { upsert: true, new: true },
    );
  } catch (err) {
    if (duplicateKey(err)) {
      throw new CallingDomainError("PBX customer account is already linked", "conflict");
    }
    throw err;
  }
}

export async function getCallingProviderAccount(
  merchantIdInput: Types.ObjectId | string,
  providerKeyInput = LOCAL_PBX_PROVIDER_KEY,
) {
  const merchantId = asObjectId(merchantIdInput, "merchantId");
  const providerKey = providerKeyInput.trim().toLowerCase();
  const account = await CallingProviderAccount.findOne({
    merchantId,
    providerKey,
    status: "active",
  }).lean();
  if (!account) throw new CallingDomainError("PBX account not linked", "not_found");
  return account;
}

export async function createMerchantUser(input: {
  merchantId: Types.ObjectId | string;
  email: string;
  name?: string;
  phone?: string;
  role?: MerchantUserRole;
  status?: MerchantUserStatus;
}) {
  const merchantId = asObjectId(input.merchantId, "merchantId");
  const existing = await MerchantUser.findOne({
    merchantId,
    email: input.email.trim().toLowerCase(),
  })
    .select("_id")
    .lean();
  if (existing) {
    throw new CallingDomainError("merchant user already exists", "conflict");
  }
  try {
    return await MerchantUser.create({
      merchantId,
      email: input.email,
      name: input.name,
      phone: input.phone,
      role: input.role ?? "agent",
      status: input.status ?? "active",
    });
  } catch (err) {
    if (duplicateKey(err)) {
      throw new CallingDomainError("merchant user already exists", "conflict");
    }
    throw err;
  }
}

async function loadMerchantUser(merchantId: Types.ObjectId, userId: Types.ObjectId) {
  const user = await MerchantUser.findOne({ _id: userId, merchantId }).lean();
  if (!user) throw new CallingDomainError("agent not found", "not_found");
  return user;
}

async function loadExtension(merchantId: Types.ObjectId, extensionId: Types.ObjectId) {
  const extension = await CallingExtension.findOne({ _id: extensionId, merchantId }).lean();
  if (!extension) throw new CallingDomainError("extension not found", "not_found");
  return extension;
}

async function loadNumber(merchantId: Types.ObjectId, numberId: Types.ObjectId) {
  const number = await CallingNumber.findOne({ _id: numberId, merchantId }).lean();
  if (!number) throw new CallingDomainError("business number not found", "not_found");
  return number;
}

export async function createCallingExtension(input: {
  merchantId: Types.ObjectId | string;
  extension: string;
  assignedUserId?: Types.ObjectId | string | null;
  label?: string;
  status?: "active" | "inactive";
}) {
  const merchantId = asObjectId(input.merchantId, "merchantId");
  let assignedUserId: Types.ObjectId | undefined;
  if (input.assignedUserId) {
    assignedUserId = asObjectId(input.assignedUserId, "assignedUserId");
    await loadMerchantUser(merchantId, assignedUserId);
  }

  const conflict = await CallingExtension.findOne({
    merchantId,
    $or: [
      { extension: input.extension },
      ...(assignedUserId ? [{ assignedUserId }] : []),
    ],
  })
    .select("_id")
    .lean();
  if (conflict) {
    throw new CallingDomainError("extension already exists or is already assigned", "conflict");
  }

  try {
    return await CallingExtension.create({
      merchantId,
      extension: input.extension,
      assignedUserId,
      label: input.label,
      status: input.status ?? "active",
    });
  } catch (err) {
    if (duplicateKey(err)) {
      throw new CallingDomainError("extension already exists or is already assigned", "conflict");
    }
    throw err;
  }
}

export async function createCallingNumber(input: {
  merchantId: Types.ObjectId | string;
  phoneNumber: string;
  providerKey?: string;
  providerNumberId?: string;
  label?: string;
  assignedExtensionId?: Types.ObjectId | string | null;
  status?: "active" | "inactive";
}) {
  const merchantId = asObjectId(input.merchantId, "merchantId");
  const normalizedPhone = normalizePhone(input.phoneNumber);
  if (!normalizedPhone) {
    throw new CallingDomainError("invalid phone number", "bad_request");
  }

  let assignedExtensionId: Types.ObjectId | undefined;
  if (input.assignedExtensionId) {
    assignedExtensionId = asObjectId(input.assignedExtensionId, "assignedExtensionId");
    await loadExtension(merchantId, assignedExtensionId);
  }

  const numberConflict = await CallingNumber.findOne({
    $or: [
      { normalizedPhone },
      ...(input.providerKey && input.providerNumberId
        ? [
            {
              providerKey: input.providerKey.trim().toLowerCase(),
              providerNumberId: input.providerNumberId,
            },
          ]
        : []),
    ],
  })
    .select("_id")
    .lean();
  if (numberConflict) {
    throw new CallingDomainError("business number already exists", "conflict");
  }

  try {
    return await CallingNumber.create({
      merchantId,
      phoneNumber: input.phoneNumber,
      normalizedPhone,
      providerKey: input.providerKey,
      providerNumberId: input.providerNumberId,
      label: input.label,
      assignedExtensionId,
      status: input.status ?? "active",
    });
  } catch (err) {
    if (duplicateKey(err)) {
      throw new CallingDomainError("business number already exists", "conflict");
    }
    throw err;
  }
}

export async function createCallSession(input: {
  merchantId: Types.ObjectId | string;
  direction: "inbound" | "outbound";
  agentUserId?: Types.ObjectId | string | null;
  customerPhone?: string;
  customerRefType?: string;
  customerRefId?: string;
  extensionId?: Types.ObjectId | string | null;
  businessNumberId?: Types.ObjectId | string | null;
  providerKey?: string;
  providerCallId?: string;
  startedAt?: Date;
}) {
  const merchantId = asObjectId(input.merchantId, "merchantId");
  let agentUserId: Types.ObjectId | undefined;
  let extensionId: Types.ObjectId | undefined;
  let businessNumberId: Types.ObjectId | undefined;
  let extension: string | undefined;
  let businessNumber: string | undefined;

  if (input.agentUserId) {
    agentUserId = asObjectId(input.agentUserId, "agentUserId");
    await loadMerchantUser(merchantId, agentUserId);
  }
  if (input.extensionId) {
    extensionId = asObjectId(input.extensionId, "extensionId");
    const ext = await loadExtension(merchantId, extensionId);
    extension = ext.extension;
    if (ext.assignedUserId && agentUserId && !agentUserId.equals(ext.assignedUserId)) {
      throw new CallingDomainError("extension is assigned to another agent", "conflict");
    }
  }
  if (input.businessNumberId) {
    businessNumberId = asObjectId(input.businessNumberId, "businessNumberId");
    const number = await loadNumber(merchantId, businessNumberId);
    businessNumber = number.normalizedPhone;
  }

  const plan = await merchantPlan(merchantId);
  let reservedCallMinutes = 0;
  if (input.direction === "outbound") {
    const reservation = await reserveQuota(merchantId, plan, "callMinutesUsed", 1);
    if (!reservation.allowed) {
      throw new CallingDomainError("call minute quota reached", "quota_exhausted");
    }
    reservedCallMinutes = 1;
  }

  try {
    if (input.providerKey && input.providerCallId) {
      const existingProviderCall = await CallSession.findOne({
        merchantId,
        providerKey: input.providerKey.trim().toLowerCase(),
        providerCallId: input.providerCallId,
      })
        .select("_id")
        .lean();
      if (existingProviderCall) {
        throw new CallingDomainError("provider call already exists", "conflict");
      }
    }
    const session = await CallSession.create({
      merchantId,
      agentUserId,
      customerRefType: input.customerRefType,
      customerRefId: input.customerRefId,
      customerPhone: input.customerPhone,
      customerPhoneNormalized: input.customerPhone ? normalizePhone(input.customerPhone) : undefined,
      direction: input.direction,
      extensionId,
      extension,
      businessNumberId,
      businessNumber,
      providerKey: input.providerKey,
      providerCallId: input.providerCallId,
      status: "created",
      startedAt: input.startedAt ?? new Date(),
      reservedCallMinutes,
    });
    if (input.direction === "outbound") {
      await bumpUsage(merchantId, "callsInitiated", 1);
    }
    return session;
  } catch (err) {
    if (reservedCallMinutes > 0) {
      await releaseQuota(merchantId, "callMinutesUsed", reservedCallMinutes).catch(() => {});
    }
    if (duplicateKey(err)) {
      throw new CallingDomainError("provider call already exists", "conflict");
    }
    throw err;
  }
}

export async function provisionLocalPbxExtension(input: {
  merchantId: Types.ObjectId | string;
  extensionId: Types.ObjectId | string;
  sipPassword: string;
  isWebrtc?: boolean;
}) {
  localPbxAccountRequired();
  const merchantId = asObjectId(input.merchantId, "merchantId");
  const extensionId = asObjectId(input.extensionId, "extensionId");
  const [account, extension] = await Promise.all([
    getCallingProviderAccount(merchantId),
    CallingExtension.findOne({ _id: extensionId, merchantId }),
  ]);
  if (!extension) throw new CallingDomainError("extension not found", "not_found");
  const client = getLocalPbxClient();
  const raw = await client.createExtension({
    customerId: account.providerCustomerId,
    extension: extension.extension,
    password: input.sipPassword,
    isWebrtc: input.isWebrtc,
  });
  extension.providerKey = LOCAL_PBX_PROVIDER_KEY;
  extension.providerExtensionId = extension.extension;
  await extension.save();
  return { extension, raw };
}

export async function createLocalPbxInboundRoute(input: {
  merchantId: Types.ObjectId | string;
  businessNumberId: Types.ObjectId | string;
  destinationType: "ivr" | "extension" | "queue" | "time_condition";
  destinationId: string;
}) {
  localPbxAccountRequired();
  const merchantId = asObjectId(input.merchantId, "merchantId");
  const businessNumberId = asObjectId(input.businessNumberId, "businessNumberId");
  const [account, number] = await Promise.all([
    getCallingProviderAccount(merchantId),
    CallingNumber.findOne({ _id: businessNumberId, merchantId }).lean(),
  ]);
  if (!number) throw new CallingDomainError("business number not found", "not_found");
  const client = getLocalPbxClient();
  return client.createInboundRoute({
    customerId: account.providerCustomerId,
    didNumber: number.normalizedPhone,
    destinationType: input.destinationType,
    destinationId: input.destinationId,
  });
}

export async function startLocalPbxOutboundCall(input: {
  merchantId: Types.ObjectId | string;
  agentUserId?: Types.ObjectId | string | null;
  extensionId: Types.ObjectId | string;
  businessNumberId?: Types.ObjectId | string | null;
  customerPhone: string;
  customerRefType?: string;
  customerRefId?: string;
}) {
  localPbxAccountRequired();
  const merchantId = asObjectId(input.merchantId, "merchantId");
  const extensionId = asObjectId(input.extensionId, "extensionId");
  const [account, extension] = await Promise.all([
    getCallingProviderAccount(merchantId),
    loadExtension(merchantId, extensionId),
  ]);
  const normalizedPhone = normalizePhone(input.customerPhone);
  if (!normalizedPhone) throw new CallingDomainError("invalid customer phone", "bad_request");

  const session = await createCallSession({
    merchantId,
    direction: "outbound",
    agentUserId: input.agentUserId,
    customerPhone: input.customerPhone,
    customerRefType: input.customerRefType,
    customerRefId: input.customerRefId,
    extensionId,
    businessNumberId: input.businessNumberId,
    providerKey: LOCAL_PBX_PROVIDER_KEY,
  });

  try {
    const client = getLocalPbxClient();
    const result = await client.originate({
      customerId: account.providerCustomerId,
      extension: extension.extension,
      phoneNumber: normalizedPhone,
    });
    await CallSession.updateOne(
      { _id: session._id, merchantId },
      {
        $set: {
          providerCallId: result.providerCallId ?? undefined,
          status: "queued",
          metadata: {
            providerOriginateStatus: result.status,
            providerOriginateResponse: result.raw,
          },
        },
      },
    );
    return {
      sessionId: String(session._id),
      providerCallId: result.providerCallId,
      status: result.status ?? "queued",
    };
  } catch (err) {
    await transitionCallSession({
      merchantId,
      callSessionId: session._id,
      status: "failed",
      failureReason: err instanceof Error ? err.message : "local PBX originate failed",
    }).catch(() => {});
    throw err;
  }
}

function asteriskConfigRequired(): void {
  if (!isAsteriskConfigured()) {
    throw new CallingDomainError("Asterisk PBX is not configured", "bad_request");
  }
}

/**
 * Click-to-call via the self-hosted Asterisk PBX.
 *
 * Rings the agent extension first, then the dialplan dials the customer from
 * a deny-by-default context, so ConfirmX cannot cause an unapproved
 * destination to be dialled even if a bad number reaches this function.
 *
 * ConfirmX holds no SIP credentials; the PBX owns SIP entirely.
 */
export async function startAsteriskOutboundCall(input: {
  merchantId: Types.ObjectId | string;
  agentUserId?: Types.ObjectId | string | null;
  extensionId: Types.ObjectId | string;
  businessNumberId?: Types.ObjectId | string | null;
  customerPhone: string;
  customerRefType?: string;
  customerRefId?: string;
}) {
  asteriskConfigRequired();
  const merchantId = asObjectId(input.merchantId, "merchantId");
  const extensionId = asObjectId(input.extensionId, "extensionId");
  const extension = await loadExtension(merchantId, extensionId);

  const normalizedPhone = normalizePhone(input.customerPhone);
  if (!normalizedPhone) throw new CallingDomainError("invalid customer phone", "bad_request");

  // Business DID presented to the customer, when the merchant owns one.
  let callerId: string | undefined;
  if (input.businessNumberId) {
    const number = await loadNumber(merchantId, asObjectId(input.businessNumberId, "businessNumberId"));
    callerId = number.normalizedPhone ?? undefined;
  }

  const session = await createCallSession({
    merchantId,
    direction: "outbound",
    agentUserId: input.agentUserId,
    customerPhone: input.customerPhone,
    customerRefType: input.customerRefType,
    customerRefId: input.customerRefId,
    extensionId,
    businessNumberId: input.businessNumberId,
    providerKey: ASTERISK_PROVIDER_KEY,
  });

  try {
    const result = await getAsteriskClient().originate({
      agentChannel: agentChannelFor(extension.extension),
      destination: normalizedPhone,
      context: asteriskOutboundContext(),
      callerId,
      sessionId: String(session._id),
    });
    await CallSession.updateOne(
      { _id: session._id, merchantId },
      {
        $set: {
          providerCallId: result.providerCallId ?? undefined,
          status: "queued",
          metadata: { providerOriginateStatus: result.status },
        },
      },
    );
    return {
      sessionId: String(session._id),
      providerCallId: result.providerCallId,
      status: result.status ?? "queued",
    };
  } catch (err) {
    await transitionCallSession({
      merchantId,
      callSessionId: session._id,
      status: "failed",
      failureReason: err instanceof Error ? err.message : "asterisk originate failed",
    }).catch(() => {});
    throw err;
  }
}

/**
 * Feed a raw AMI event into the calling foundation.
 *
 * Tenant authorization comes from the CallSession we already own, never from
 * the event payload: we look the session up by `providerCallId` and only then
 * use its merchantId. An event naming an unknown call is ignored.
 *
 * Idempotency is handled by `processCallEvent` via the deterministic
 * `providerEventId` the mapper derives from the Asterisk uniqueid.
 */
export async function handleAsteriskCallEvent(event: Record<string, unknown>) {
  const mapped = mapAmiEventToCallEvent(event);
  if (!mapped) return { handled: false as const, reason: "unmapped_event" };

  const session = await CallSession.findOne({
    providerKey: ASTERISK_PROVIDER_KEY,
    providerCallId: mapped.providerCallId,
  })
    .select("_id merchantId status")
    .lean();
  if (!session) return { handled: false as const, reason: "unknown_call" };

  // A terminal session must not be re-opened by a late or replayed event.
  if (TERMINAL_STATUSES.has(session.status as CallSessionStatus)) {
    return { handled: false as const, reason: "already_terminal" };
  }

  const result = await processCallEvent({
    merchantId: session.merchantId,
    callSessionId: session._id,
    providerKey: ASTERISK_PROVIDER_KEY,
    providerEventId: mapped.providerEventId,
    eventType: mapped.eventType,
    occurredAt: mapped.occurredAt,
    durationSeconds: mapped.durationSeconds,
    failureCode: mapped.failureCode,
    failureReason: mapped.failureReason,
  });

  return { handled: true as const, duplicate: result.duplicate, eventType: mapped.eventType };
}

export async function transitionCallSession(input: {
  merchantId: Types.ObjectId | string;
  callSessionId: Types.ObjectId | string;
  status: CallSessionStatus;
  occurredAt?: Date;
  durationSeconds?: number;
  failureCode?: string;
  failureReason?: string;
}) {
  const merchantId = asObjectId(input.merchantId, "merchantId");
  const callSessionId = asObjectId(input.callSessionId, "callSessionId");
  const session = await CallSession.findOne({ _id: callSessionId, merchantId });
  if (!session) throw new CallingDomainError("call session not found", "not_found");

  const currentStatus = session.status as CallSessionStatus;
  if (currentStatus === input.status) return session;
  if (TERMINAL_STATUSES.has(currentStatus)) {
    throw new CallingDomainError("terminal call session cannot transition", "invalid_transition");
  }
  if (!ALLOWED_TRANSITIONS[currentStatus].has(input.status)) {
    throw new CallingDomainError(`invalid transition ${currentStatus} -> ${input.status}`, "invalid_transition");
  }

  const occurredAt = input.occurredAt ?? new Date();
  session.status = input.status;
  session.lastEventAt = occurredAt;
  if (input.status === "answered" && !session.answeredAt) {
    session.answeredAt = occurredAt;
  }
  if (TERMINAL_STATUSES.has(input.status)) {
    session.endedAt = session.endedAt ?? occurredAt;
    if (typeof input.durationSeconds === "number") {
      session.durationSeconds = Math.max(0, Math.floor(input.durationSeconds));
    } else if (session.answeredAt && session.endedAt) {
      session.durationSeconds = Math.max(
        0,
        Math.floor((session.endedAt.getTime() - session.answeredAt.getTime()) / 1000),
      );
    }
    session.failureCode = input.failureCode ?? session.failureCode;
    session.failureReason = input.failureReason ?? session.failureReason;
  }

  await session.save();
  if (TERMINAL_STATUSES.has(input.status)) {
    await finalizeCallUsage({
      merchantId,
      callSessionId,
      durationSeconds: session.durationSeconds ?? 0,
    });
  }
  return session;
}

export async function finalizeCallUsage(input: {
  merchantId: Types.ObjectId | string;
  callSessionId: Types.ObjectId | string;
  durationSeconds: number;
}) {
  const merchantId = asObjectId(input.merchantId, "merchantId");
  const callSessionId = asObjectId(input.callSessionId, "callSessionId");
  const minutes = billedMinutes(input.durationSeconds);
  const session = await CallSession.findOneAndUpdate(
    {
      _id: callSessionId,
      merchantId,
      usageFinalizedAt: { $exists: false },
    },
    {
      $set: {
        durationSeconds: Math.max(0, Math.floor(input.durationSeconds)),
        billedMinutes: minutes,
        usageFinalizedAt: new Date(),
      },
    },
    { new: false },
  ).lean();
  if (!session) return { finalized: false, billedMinutes: minutes, deltaMinutes: 0 };

  const reserved = session.reservedCallMinutes ?? 0;
  const delta = minutes - reserved;
  if (delta > 0) {
    await bumpUsage(merchantId, "callMinutesUsed", delta);
  } else if (delta < 0) {
    await releaseQuota(merchantId, "callMinutesUsed", Math.abs(delta));
  }
  return { finalized: true, billedMinutes: minutes, deltaMinutes: delta };
}

export async function processCallEvent(input: {
  merchantId: Types.ObjectId | string;
  callSessionId: Types.ObjectId | string;
  providerKey: string;
  providerEventId: string;
  eventType: string;
  occurredAt?: Date;
  durationSeconds?: number;
  failureCode?: string;
  failureReason?: string;
  payload?: unknown;
}) {
  const merchantId = asObjectId(input.merchantId, "merchantId");
  const callSessionId = asObjectId(input.callSessionId, "callSessionId");
  const session = await CallSession.findOne({ _id: callSessionId, merchantId })
    .select("_id")
    .lean();
  if (!session) throw new CallingDomainError("call session not found", "not_found");

  const providerKey = input.providerKey.trim().toLowerCase();
  const eventType = input.eventType.trim().toLowerCase();
  const occurredAt = input.occurredAt ?? new Date();
  let event;
  const existingEvent = await CallEvent.findOne({
    merchantId,
    providerKey,
    providerEventId: input.providerEventId,
  }).lean();
  if (existingEvent) {
    return { duplicate: true, event: existingEvent, session: null };
  }
  try {
    event = await CallEvent.create({
      merchantId,
      callSessionId,
      providerKey,
      providerEventId: input.providerEventId,
      eventType,
      occurredAt,
      payload: input.payload,
      processedAt: new Date(),
    });
  } catch (err) {
    if (duplicateKey(err)) {
      const existing = await CallEvent.findOne({
        merchantId,
        providerKey,
        providerEventId: input.providerEventId,
      }).lean();
      return { duplicate: true, event: existing, session: null };
    }
    throw err;
  }

  const status = EVENT_STATUS[eventType];
  const updatedSession = status
    ? await transitionCallSession({
        merchantId,
        callSessionId,
        status,
        occurredAt,
        durationSeconds: input.durationSeconds,
        failureCode: input.failureCode,
        failureReason: input.failureReason,
      })
    : null;

  return { duplicate: false, event, session: updatedSession };
}

export async function syncLocalPbxCdr(input: {
  merchantId: Types.ObjectId | string;
  startDate?: string;
  endDate?: string;
}) {
  localPbxAccountRequired();
  const merchantId = asObjectId(input.merchantId, "merchantId");
  const account = await getCallingProviderAccount(merchantId);
  const client = getLocalPbxClient();
  const records = await client.getCdr({
    customerId: account.providerCustomerId,
    startDate: input.startDate,
    endDate: input.endDate,
  });
  let processed = 0;
  let duplicate = 0;
  let unmapped = 0;

  for (const record of records) {
    const providerCallId = cdrEventId(record);
    if (!providerCallId) {
      unmapped += 1;
      continue;
    }
    const session = await CallSession.findOne({
      merchantId,
      providerKey: LOCAL_PBX_PROVIDER_KEY,
      providerCallId,
    })
      .select("_id")
      .lean();
    if (!session) {
      unmapped += 1;
      continue;
    }
    const result = await processCallEvent({
      merchantId,
      callSessionId: session._id,
      providerKey: LOCAL_PBX_PROVIDER_KEY,
      providerEventId: `cdr:${providerCallId}`,
      eventType: cdrStatus(record),
      durationSeconds: cdrDuration(record),
      payload: record,
    });
    if (result.duplicate) duplicate += 1;
    else processed += 1;
  }

  await CallingProviderAccount.updateOne(
    { _id: account._id, merchantId },
    { $set: { lastSyncedAt: new Date() } },
  );
  return { fetched: records.length, processed, duplicate, unmapped };
}
