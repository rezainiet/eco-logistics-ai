import { env } from "../../../env.js";

export const LOCAL_PBX_PROVIDER_KEY = env.LOCAL_PBX_PROVIDER_KEY || "local_pbx";

export type LocalPbxDisposition = "ANSWERED" | "NO ANSWER" | "BUSY" | "FAILED";

export interface LocalPbxConfig {
  baseUrl: string;
  apiToken: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface LocalPbxCdrRecord {
  id?: string | number;
  uniqueid?: string;
  call_id?: string;
  caller?: string;
  caller_number?: string;
  callee?: string;
  callee_number?: string;
  extension?: string;
  did_number?: string;
  start_time?: string;
  call_date?: string;
  duration?: number | string;
  billsec?: number | string;
  disposition?: string;
  status?: string;
  [key: string]: unknown;
}

export interface OriginateResult {
  providerCallId: string | null;
  status: string | null;
  raw: unknown;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function assertConfigured(config: LocalPbxConfig): void {
  if (!config.baseUrl || !config.apiToken) {
    throw new Error("local PBX API is not configured");
  }
}

function pickString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function pickProviderCallId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  const data = obj.data && typeof obj.data === "object" ? obj.data as Record<string, unknown> : obj;
  return (
    pickString(data.call_id) ??
    pickString(data.callId) ??
    pickString(data.uniqueid) ??
    pickString(data.id) ??
    null
  );
}

function pickStatus(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  const data = obj.data && typeof obj.data === "object" ? obj.data as Record<string, unknown> : obj;
  return pickString(data.status) ?? pickString(obj.status);
}

export class LocalPbxClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: LocalPbxConfig) {
    assertConfigured(config);
    this.baseUrl = trimSlash(config.baseUrl);
    this.apiToken = config.apiToken;
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  async ping(): Promise<unknown> {
    return this.request("GET", "/ping");
  }

  async listExtensions(customerId: string): Promise<unknown> {
    return this.request("GET", `/telephony/customers/${encodeURIComponent(customerId)}/extensions`);
  }

  async createExtension(input: {
    customerId: string;
    extension: string;
    password: string;
    isWebrtc?: boolean;
  }): Promise<unknown> {
    return this.request("POST", `/telephony/customers/${encodeURIComponent(input.customerId)}/extensions`, {
      extension: input.extension,
      password: input.password,
      is_webrtc: input.isWebrtc ?? false,
    });
  }

  async requestNumber(input: {
    customerId: string;
    preferredDigits: string;
    providerId: number;
    requestedChannels: number;
    notes?: string;
  }): Promise<unknown> {
    return this.request(
      "POST",
      `/telephony/customers/${encodeURIComponent(input.customerId)}/numbers/request`,
      {
        preferred_digits: input.preferredDigits,
        provider_id: input.providerId,
        requested_channels: input.requestedChannels,
        notes: input.notes,
      },
    );
  }

  async createInboundRoute(input: {
    customerId: string;
    didNumber: string;
    destinationType: "ivr" | "extension" | "queue" | "time_condition";
    destinationId: string;
  }): Promise<unknown> {
    return this.request(
      "POST",
      `/telephony/customers/${encodeURIComponent(input.customerId)}/inbound-routes`,
      {
        did_number: input.didNumber,
        destination_type: input.destinationType,
        destination_id: input.destinationId,
      },
    );
  }

  async createOutboundRoute(input: {
    customerId: string;
    name: string;
    matchPattern: string;
    trunkId: number;
  }): Promise<unknown> {
    return this.request(
      "POST",
      `/telephony/customers/${encodeURIComponent(input.customerId)}/outbound-routes`,
      {
        name: input.name,
        match_pattern: input.matchPattern,
        trunk_id: input.trunkId,
      },
    );
  }

  async originate(input: {
    customerId: string;
    extension: string;
    phoneNumber: string;
  }): Promise<OriginateResult> {
    const raw = await this.request(
      "POST",
      `/customers/${encodeURIComponent(input.customerId)}/calls/originate`,
      {
        extension: input.extension,
        phone_number: input.phoneNumber,
      },
    );
    return {
      providerCallId: pickProviderCallId(raw),
      status: pickStatus(raw),
      raw,
    };
  }

  async getCdr(input: {
    customerId: string;
    startDate?: string;
    endDate?: string;
    disposition?: LocalPbxDisposition;
  }): Promise<LocalPbxCdrRecord[]> {
    const params = new URLSearchParams();
    if (input.startDate) params.set("start_date", input.startDate);
    if (input.endDate) params.set("end_date", input.endDate);
    if (input.disposition) params.set("disposition", input.disposition);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const raw = await this.request("GET", `/customers/${encodeURIComponent(input.customerId)}/cdr${suffix}`);
    if (Array.isArray(raw)) return raw as LocalPbxCdrRecord[];
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      if (Array.isArray(obj.data)) return obj.data as LocalPbxCdrRecord[];
      if (obj.data && typeof obj.data === "object" && Array.isArray((obj.data as Record<string, unknown>).records)) {
        return (obj.data as Record<string, unknown>).records as LocalPbxCdrRecord[];
      }
    }
    return [];
  }

  private async request(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}${normalizePath(path)}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      const payload = text ? JSON.parse(text) as unknown : null;
      if (!res.ok) {
        throw new Error(`local PBX API ${method} ${path} failed with ${res.status}`);
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function getLocalPbxClient(): LocalPbxClient {
  return new LocalPbxClient({
    baseUrl: env.LOCAL_PBX_BASE_URL ?? "",
    apiToken: env.LOCAL_PBX_API_TOKEN ?? "",
    timeoutMs: env.LOCAL_PBX_TIMEOUT_MS,
  });
}

export function isLocalPbxConfigured(): boolean {
  return Boolean(env.LOCAL_PBX_ENABLED && env.LOCAL_PBX_BASE_URL && env.LOCAL_PBX_API_TOKEN);
}
