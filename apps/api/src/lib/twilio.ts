import twilio from "twilio";
import type { Twilio } from "twilio";
import { env } from "../env.js";

let _client: Twilio | null = null;

function getClient(): Twilio {
  if (!_client) {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
      throw new Error("Twilio credentials not configured");
    }
    _client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }
  return _client;
}

export function isTwilioConfigured(): boolean {
  return !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER);
}

function normalize(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.startsWith("+")) return trimmed;
  if (/^8801\d{9}$/.test(trimmed)) return `+${trimmed}`;
  if (/^01\d{9}$/.test(trimmed)) return `+88${trimmed}`;
  return trimmed;
}

export interface InitiateCallArgs {
  to: string;
  statusCallbackUrl: string;
  record?: boolean;
}

export async function initiateCall(args: InitiateCallArgs) {
  if (!env.TWILIO_PHONE_NUMBER) {
    throw new Error("TWILIO_PHONE_NUMBER not configured");
  }
  const client = getClient();
  const call = await client.calls.create({
    to: normalize(args.to),
    from: env.TWILIO_PHONE_NUMBER,
    url: "http://demo.twilio.com/docs/voice.xml",
    statusCallback: args.statusCallbackUrl,
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    statusCallbackMethod: "POST",
    record: args.record ?? false,
  });
  return {
    sid: call.sid,
    status: call.status,
    from: call.from,
    to: call.to,
    dateCreated: call.dateCreated,
  };
}

export async function getCallDetails(sid: string) {
  const client = getClient();
  const call = await client.calls(sid).fetch();
  return {
    sid: call.sid,
    status: call.status,
    duration: call.duration ? Number(call.duration) : null,
    price: call.price ? Number(call.price) : null,
    priceUnit: call.priceUnit,
    startTime: call.startTime,
    endTime: call.endTime,
    from: call.from,
    to: call.to,
  };
}

export async function hangupCall(sid: string) {
  const client = getClient();
  const call = await client.calls(sid).update({ status: "completed" });
  return { sid: call.sid, status: call.status };
}

export function validateSignature(
  signature: string | undefined,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!env.TWILIO_AUTH_TOKEN || !signature) return false;
  return twilio.validateRequest(env.TWILIO_AUTH_TOKEN, signature, url, params);
}

export function normalizePhone(phone: string): string {
  return normalize(phone);
}
