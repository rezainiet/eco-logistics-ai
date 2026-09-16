import { EventEmitter } from "node:events";
import type net from "node:net";
import { describe, expect, it } from "vitest";
import {
  AsteriskAmiClient,
  mapAmiEventToCallEvent,
  parseAmiBlock,
} from "../src/lib/calling/providers/asterisk.js";

const CRLF = "\r\n";

/** Minimal in-memory stand-in for a net.Socket speaking AMI. */
class FakeSocket extends EventEmitter {
  public written: string[] = [];
  public destroyed = false;

  constructor(private readonly onAction: (action: string, socket: FakeSocket) => void) {
    super();
    setImmediate(() => this.emit("connect"));
  }

  write(data: string): boolean {
    this.written.push(data);
    if (data.startsWith("Action: Login")) {
      setImmediate(() =>
        this.emit(
          "data",
          Buffer.from(`Response: Success${CRLF}Message: Authentication accepted${CRLF}${CRLF}`),
        ),
      );
    } else if (data.startsWith("Action: ") && !data.startsWith("Action: Logoff")) {
      const action = (data.split(CRLF)[0] ?? "").replace("Action: ", "");
      setImmediate(() => this.onAction(action, this));
    }
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }
}

function clientWith(onAction: (action: string, socket: FakeSocket) => void, sockets: FakeSocket[] = []) {
  return new AsteriskAmiClient({
    host: "127.0.0.1",
    port: 5038,
    username: "confirmx",
    password: "not-a-real-secret",
    timeoutMs: 2000,
    connectFn: () => {
      const s = new FakeSocket(onAction);
      sockets.push(s);
      return s as unknown as net.Socket;
    },
  });
}

describe("parseAmiBlock", () => {
  it("parses AMI key/value lines and keeps the first occurrence", () => {
    const fields = parseAmiBlock(
      `Response: Success${CRLF}Uniqueid: 1789.1${CRLF}Uniqueid: 1789.2${CRLF}`,
    );
    expect(fields).toMatchObject({ Response: "Success", Uniqueid: "1789.1" });
  });
});

describe("mapAmiEventToCallEvent", () => {
  it("maps Newstate Ringing to a ringing event", () => {
    const mapped = mapAmiEventToCallEvent({
      Event: "Newstate",
      ChannelStateDesc: "Ringing",
      Uniqueid: "1789.1",
      Linkedid: "1789.1",
    });
    expect(mapped).toMatchObject({ eventType: "ringing", providerCallId: "1789.1" });
  });

  it("maps Newstate Up to answered", () => {
    const mapped = mapAmiEventToCallEvent({
      Event: "Newstate",
      ChannelStateDesc: "Up",
      Uniqueid: "1789.2",
      Linkedid: "1789.1",
    });
    // Linkedid is the stable call id across both legs of a click-to-call.
    expect(mapped).toMatchObject({ eventType: "answered", providerCallId: "1789.1" });
  });

  it("maps a normal-clearing hangup to completed with billable seconds", () => {
    const mapped = mapAmiEventToCallEvent({
      Event: "Hangup",
      Cause: "16",
      "Cause-txt": "Normal Clearing",
      BillableSeconds: "42",
      Uniqueid: "1789.1",
      Linkedid: "1789.1",
    });
    expect(mapped).toMatchObject({
      eventType: "completed",
      durationSeconds: 42,
      failureCode: undefined,
    });
  });

  it("maps busy and no-answer hangup causes to failed and missed", () => {
    expect(
      mapAmiEventToCallEvent({ Event: "Hangup", Cause: "17", Uniqueid: "a", Linkedid: "a" }),
    ).toMatchObject({ eventType: "failed", failureCode: "17" });
    expect(
      mapAmiEventToCallEvent({ Event: "Hangup", Cause: "19", Uniqueid: "b", Linkedid: "b" }),
    ).toMatchObject({ eventType: "missed" });
  });

  it("maps DialEnd statuses", () => {
    expect(
      mapAmiEventToCallEvent({ Event: "DialEnd", DialStatus: "ANSWER", Uniqueid: "c", Linkedid: "c" }),
    ).toMatchObject({ eventType: "answered" });
    expect(
      mapAmiEventToCallEvent({ Event: "DialEnd", DialStatus: "BUSY", Uniqueid: "d", Linkedid: "d" }),
    ).toMatchObject({ eventType: "failed", failureCode: "BUSY" });
    expect(
      mapAmiEventToCallEvent({ Event: "DialEnd", DialStatus: "CANCEL", Uniqueid: "e", Linkedid: "e" }),
    ).toMatchObject({ eventType: "cancelled" });
  });

  it("produces a deterministic providerEventId so replays are idempotent", () => {
    const event = { Event: "Hangup", Cause: "16", Uniqueid: "1789.9", Linkedid: "1789.9" };
    const first = mapAmiEventToCallEvent(event);
    const second = mapAmiEventToCallEvent(event);
    expect(first?.providerEventId).toBe(second?.providerEventId);
    expect(first?.providerEventId).toBe("1789.9:hangup");
  });

  it("ignores events that carry no state transition or no call id", () => {
    expect(mapAmiEventToCallEvent({ Event: "VarSet", Uniqueid: "x", Linkedid: "x" })).toBeNull();
    expect(mapAmiEventToCallEvent({ Event: "Hangup" })).toBeNull();
    expect(mapAmiEventToCallEvent({})).toBeNull();
  });
});

describe("AsteriskAmiClient", () => {
  it("logs in and issues Originate with the allow-listed context", async () => {
    const sockets: FakeSocket[] = [];
    const client = clientWith((action, socket) => {
      if (action === "Originate") {
        socket.emit(
          "data",
          Buffer.from(
            `Response: Success${CRLF}Message: Originate successfully queued${CRLF}Uniqueid: 1789.77${CRLF}${CRLF}`,
          ),
        );
      }
    }, sockets);

    const result = await client.originate({
      agentChannel: "PJSIP/1001",
      destination: "01712345678",
      context: "from-confirmx-test",
      callerId: "09638080008",
      sessionId: "sess-1",
    });

    expect(result).toMatchObject({ providerCallId: "1789.77", status: "queued" });

    const originate = (sockets[0]?.written ?? []).find((w) => w.startsWith("Action: Originate")) ?? "";
    expect(originate).toContain("Channel: PJSIP/1001");
    expect(originate).toContain("Context: from-confirmx-test");
    expect(originate).toContain("Exten: 01712345678");
    expect(originate).toContain("CallerID: 09638080008");
    // Session id rides along as a channel variable for CRM correlation.
    expect(originate).toContain("Variable: CONFIRMX_SESSION_ID=sess-1");
  });

  it("never writes the AMI secret into the action payload", async () => {
    const sockets: FakeSocket[] = [];
    const client = clientWith((action, socket) => {
      if (action === "Ping") {
        socket.emit("data", Buffer.from(`Response: Success${CRLF}${CRLF}`));
      }
    }, sockets);

    await client.ping();
    const nonLogin = (sockets[0]?.written ?? []).filter((w) => !w.startsWith("Action: Login"));
    for (const payload of nonLogin) {
      expect(payload).not.toContain("not-a-real-secret");
    }
  });

  it("surfaces a failed Originate as a non-success status", async () => {
    const client = clientWith((action, socket) => {
      if (action === "Originate") {
        socket.emit(
          "data",
          Buffer.from(`Response: Error${CRLF}Message: Extension does not exist${CRLF}${CRLF}`),
        );
      }
    });

    const result = await client.originate({
      agentChannel: "PJSIP/1001",
      destination: "00441234567890",
      context: "from-confirmx-test",
    });
    expect(result.status).toBe("Extension does not exist");
    expect(result.providerCallId).toBeNull();
  });

  it("rejects when authentication fails", async () => {
    const client = new AsteriskAmiClient({
      host: "127.0.0.1",
      port: 5038,
      username: "confirmx",
      password: "wrong",
      timeoutMs: 2000,
      connectFn: () => {
        const s = new EventEmitter() as unknown as FakeSocket & net.Socket;
        (s as unknown as { write: (d: string) => boolean }).write = (data: string) => {
          if (data.startsWith("Action: Login")) {
            setImmediate(() =>
              s.emit("data", Buffer.from(`Response: Error${CRLF}Message: Authentication failed${CRLF}${CRLF}`)),
            );
          }
          return true;
        };
        (s as unknown as { destroy: () => void }).destroy = () => undefined;
        setImmediate(() => s.emit("connect"));
        return s as unknown as net.Socket;
      },
    });

    await expect(client.ping()).rejects.toThrow(/authentication failed/i);
  });

  it("requires full configuration", () => {
    expect(
      () => new AsteriskAmiClient({ host: "", port: 5038, username: "u", password: "p" }),
    ).toThrow(/not configured/i);
  });
});
