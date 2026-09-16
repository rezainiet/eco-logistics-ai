import net from "node:net";
import { env } from "../../../env.js";

/**
 * Asterisk AMI provider for the ConfirmX calling foundation.
 *
 * Transport note: AMI is bound to 127.0.0.1 on the PBX host and is NEVER
 * exposed publicly. ConfirmX must reach it over a private path (SSH tunnel,
 * WireGuard, or by running the API on the PBX host). `host`/`port` therefore
 * point at the local end of that tunnel, not at a public address.
 *
 * No SIP credentials are known to ConfirmX. The PBX owns SIP entirely; this
 * client only issues call-control actions and consumes events.
 */

export const ASTERISK_PROVIDER_KEY = env.ASTERISK_PROVIDER_KEY || "asterisk";

const CRLF = "\r\n";

export interface AsteriskAmiConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to a real TCP socket. */
  connectFn?: (host: string, port: number) => net.Socket;
}

export interface AmiResponse {
  success: boolean;
  fields: Record<string, string>;
  raw: string;
}

export interface OriginateInput {
  /** Agent endpoint to ring first, e.g. "PJSIP/1001". */
  agentChannel: string;
  /** Destination the dialplan should dial once the agent answers. */
  destination: string;
  /** Dialplan context that enforces the outbound allow-list. */
  context: string;
  /** Caller ID presented to the customer (the business DID). */
  callerId?: string;
  /** ConfirmX CallSession id, injected as a channel variable for correlation. */
  sessionId?: string;
  timeoutMs?: number;
}

export interface OriginateResult {
  providerCallId: string | null;
  status: string | null;
  raw: unknown;
}

/** Asterisk Q.850 hangup causes -> ConfirmX terminal event types. */
const HANGUP_CAUSE_EVENT: Record<string, "completed" | "failed" | "missed"> = {
  "16": "completed", // normal clearing
  "17": "failed", // user busy
  "18": "missed", // no user responding
  "19": "missed", // no answer
  "20": "missed", // subscriber absent
  "21": "failed", // call rejected
  "1": "failed", // unallocated number
  "3": "failed", // no route to destination
  "34": "failed", // no circuit available
  "38": "failed", // network out of order
};

export interface NormalizedCallEvent {
  eventType: "queued" | "ringing" | "answered" | "completed" | "failed" | "missed" | "cancelled";
  providerEventId: string;
  providerCallId: string;
  occurredAt: Date;
  durationSeconds?: number;
  failureCode?: string;
  failureReason?: string;
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Map a raw AMI event to a ConfirmX call event.
 *
 * `providerEventId` is derived deterministically from the channel uniqueid and
 * the transition, so replaying the same AMI event (or re-reading CDR) is
 * idempotent at the `processCallEvent` layer.
 *
 * Returns null for AMI events that carry no ConfirmX state transition.
 */
export function mapAmiEventToCallEvent(
  event: Record<string, unknown>,
): NormalizedCallEvent | null {
  const name = str(event.Event);
  if (!name) return null;

  // Linkedid groups both legs of a click-to-call; it is the stable call id.
  const providerCallId = str(event.Linkedid) ?? str(event.Uniqueid);
  if (!providerCallId) return null;
  const uniqueid = str(event.Uniqueid) ?? providerCallId;
  const occurredAt = new Date();

  switch (name) {
    case "Newchannel":
      return {
        eventType: "queued",
        providerEventId: `${uniqueid}:queued`,
        providerCallId,
        occurredAt,
      };

    case "Newstate": {
      const state = str(event.ChannelStateDesc);
      if (state === "Ringing" || state === "Ring") {
        return {
          eventType: "ringing",
          providerEventId: `${uniqueid}:ringing`,
          providerCallId,
          occurredAt,
        };
      }
      if (state === "Up") {
        return {
          eventType: "answered",
          providerEventId: `${uniqueid}:answered`,
          providerCallId,
          occurredAt,
        };
      }
      return null;
    }

    case "DialEnd": {
      const status = (str(event.DialStatus) ?? "").toUpperCase();
      if (status === "ANSWER") {
        return {
          eventType: "answered",
          providerEventId: `${uniqueid}:answered`,
          providerCallId,
          occurredAt,
        };
      }
      if (status === "NOANSWER" || status === "CANCEL") {
        return {
          eventType: status === "CANCEL" ? "cancelled" : "missed",
          providerEventId: `${uniqueid}:dialend:${status.toLowerCase()}`,
          providerCallId,
          occurredAt,
          failureCode: status,
        };
      }
      if (status === "BUSY" || status === "CONGESTION" || status === "CHANUNAVAIL") {
        return {
          eventType: "failed",
          providerEventId: `${uniqueid}:dialend:${status.toLowerCase()}`,
          providerCallId,
          occurredAt,
          failureCode: status,
          failureReason: `dial status ${status}`,
        };
      }
      return null;
    }

    case "Hangup": {
      const cause = str(event.Cause) ?? "";
      const eventType = HANGUP_CAUSE_EVENT[cause] ?? "completed";
      const billsec = Number.parseInt(str(event.BillableSeconds) ?? "", 10);
      return {
        eventType,
        providerEventId: `${uniqueid}:hangup`,
        providerCallId,
        occurredAt,
        durationSeconds: Number.isFinite(billsec) ? billsec : undefined,
        failureCode: eventType === "completed" ? undefined : cause,
        // Cause-txt is provider text, never customer PII.
        failureReason: eventType === "completed" ? undefined : str(event["Cause-txt"]) ?? undefined,
      };
    }

    default:
      return null;
  }
}

/** Parse an AMI packet ("Key: value" lines) into a field map. */
export function parseAmiBlock(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && !(key in fields)) fields[key] = value;
  }
  return fields;
}

export class AsteriskAmiClient {
  private readonly config: AsteriskAmiConfig;

  constructor(config: AsteriskAmiConfig) {
    if (!config.host || !config.port || !config.username || !config.password) {
      throw new Error("Asterisk AMI is not configured");
    }
    this.config = config;
  }

  private connect(): net.Socket {
    if (this.config.connectFn) return this.config.connectFn(this.config.host, this.config.port);
    return net.createConnection({ host: this.config.host, port: this.config.port });
  }

  /**
   * Open a socket, log in, run one action, log off.
   *
   * Short-lived connections keep the surface small and avoid holding an AMI
   * session open across the tunnel. The AMI secret is never logged.
   */
  private async run(action: string, fields: Record<string, string | undefined>): Promise<AmiResponse> {
    const timeoutMs = this.config.timeoutMs ?? 5000;
    const socket = this.connect();

    return await new Promise<AmiResponse>((resolve, reject) => {
      let buffer = "";
      let loggedIn = false;
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.write(`Action: Logoff${CRLF}${CRLF}`);
        } catch {
          /* socket may already be closed */
        }
        socket.destroy();
        fn();
      };

      const timer = setTimeout(
        () => finish(() => reject(new Error(`AMI ${action} timed out after ${timeoutMs}ms`))),
        timeoutMs,
      );

      socket.on("error", (err) => finish(() => reject(err)));
      socket.on("close", () => {
        if (!settled) finish(() => reject(new Error(`AMI ${action} connection closed`)));
      });

      socket.on("connect", () => {
        socket.write(
          `Action: Login${CRLF}Username: ${this.config.username}${CRLF}Secret: ${this.config.password}${CRLF}${CRLF}`,
        );
      });

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");

        if (!loggedIn) {
          if (buffer.includes("Authentication failed")) {
            finish(() => reject(new Error("AMI authentication failed")));
            return;
          }
          if (!buffer.includes("Authentication accepted")) return;
          loggedIn = true;
          buffer = "";
          const lines = [`Action: ${action}`];
          for (const [key, value] of Object.entries(fields)) {
            if (value !== undefined && value !== null && value !== "") {
              lines.push(`${key}: ${value}`);
            }
          }
          socket.write(lines.join(CRLF) + CRLF + CRLF);
          return;
        }

        for (const block of buffer.split(CRLF + CRLF)) {
          const parsed = parseAmiBlock(block);
          if (!parsed.Response) continue;
          // Skip the login acknowledgement itself.
          if (parsed.Message === "Authentication accepted") continue;
          const success = parsed.Response.toLowerCase() === "success";
          finish(() => resolve({ success, fields: parsed, raw: block }));
          return;
        }
      });
    });
  }

  /**
   * Ring the agent first, then dial the customer from `context`.
   *
   * The destination is passed as the dialplan extension so the PBX allow-list
   * (deny-by-default) decides whether it may be dialled. ConfirmX cannot dial
   * an arbitrary number even if a caller supplies one.
   */
  async originate(input: OriginateInput): Promise<OriginateResult> {
    const variables: string[] = [];
    if (input.sessionId) variables.push(`CONFIRMX_SESSION_ID=${input.sessionId}`);

    const response = await this.run("Originate", {
      Channel: input.agentChannel,
      Context: input.context,
      Exten: input.destination,
      Priority: "1",
      CallerID: input.callerId,
      Timeout: String(input.timeoutMs ?? 30000),
      Async: "true",
      ...(variables.length ? { Variable: variables.join(",") } : {}),
    });

    return {
      providerCallId: response.fields.Uniqueid ?? null,
      status: response.success ? "queued" : (response.fields.Message ?? "failed"),
      raw: response.fields,
    };
  }

  async hangup(channel: string): Promise<boolean> {
    const response = await this.run("Hangup", { Channel: channel });
    return response.success;
  }

  async coreStatus(): Promise<Record<string, string>> {
    const response = await this.run("CoreStatus", {});
    return response.fields;
  }

  async ping(): Promise<boolean> {
    const response = await this.run("Ping", {});
    return response.success;
  }
}

let cachedClient: AsteriskAmiClient | null = null;

export function isAsteriskConfigured(): boolean {
  return Boolean(
    env.ASTERISK_ENABLED && env.ASTERISK_AMI_USERNAME && env.ASTERISK_AMI_PASSWORD,
  );
}

export function getAsteriskClient(): AsteriskAmiClient {
  if (!isAsteriskConfigured()) {
    throw new Error("Asterisk AMI is not configured");
  }
  if (!cachedClient) {
    cachedClient = new AsteriskAmiClient({
      host: env.ASTERISK_AMI_HOST,
      port: env.ASTERISK_AMI_PORT,
      username: env.ASTERISK_AMI_USERNAME as string,
      password: env.ASTERISK_AMI_PASSWORD as string,
      timeoutMs: env.ASTERISK_TIMEOUT_MS,
    });
  }
  return cachedClient;
}

/** Build the agent channel string, e.g. "PJSIP/1001". */
export function agentChannelFor(extension: string): string {
  return `${env.ASTERISK_CHANNEL_TECH}/${extension}`;
}

export function asteriskOutboundContext(): string {
  return env.ASTERISK_OUTBOUND_CONTEXT;
}
