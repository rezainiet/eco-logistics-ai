import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * deploy/vps/wait-ready.sh replaces deploy.sh's fixed `sleep 6` before the
 * smoke test (which reported false failures: the API needs longer to boot).
 * The script is exercised for real, with bash + curl, against local servers.
 */
const here = fileURLToPath(new URL(".", import.meta.url));
const vps = resolve(here, "../../../deploy/vps");
const script = resolve(vps, "wait-ready.sh");

function findBash(): string | null {
  const candidates = [
    process.env.CONFIRMX_TEST_BASH,
    process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : undefined,
    "bash",
  ].filter((c): c is string => !!c && (c === "bash" || existsSync(c)));
  for (const c of candidates) {
    const r = spawnSync(c, ["-c", "command -v curl >/dev/null && echo ok"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "ok") return c;
  }
  return null;
}
const bash = findBash();

function run(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile(bash!, [script, ...args], { timeout: 30_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      done({ code, out: `${stdout}${stderr}` });
    });
  });
}

const servers: http.Server[] = [];
/** A server answering 503 until `readyAfterMs` has passed, then 200. */
async function server(readyAfterMs: number): Promise<string> {
  const t0 = Date.now();
  const s = http.createServer((_req, res) => {
    res.statusCode = Date.now() - t0 >= readyAfterMs ? 200 : 503;
    res.end();
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/ready`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe.skipIf(!bash)("wait-ready.sh", () => {
  it("waits for a slow service instead of failing early", async () => {
    const slow = await server(2500);
    const fast = await server(0);
    const r = await run(["--timeout", "20", "--interval", "1", `api=${slow}`, `web=${fast}`]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/waiting\s+api .* → 503/);
    expect(r.out).toMatch(/ready\s+api/);
    expect(r.out).toMatch(/ready\s+web/);
  });

  it("fails after the timeout and names the service that never became ready", async () => {
    const never = await server(60_000);
    const ok = await server(0);
    const r = await run(["--timeout", "3", "--interval", "1", `api=${never}`, `web=${ok}`]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/NOT READY api .* last status 503 after 3s/);
    expect(r.out).not.toMatch(/NOT READY web/);
  });

  it("reports a service that is not listening at all (status 000)", async () => {
    const dead = await server(0);
    await new Promise((r) => servers.pop()!.close(r));
    const r = await run(["--timeout", "2", "--interval", "1", `sites=${dead}`]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/NOT READY sites .* last status 000/);
  });

  it("rejects bad arguments with exit 2", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["--timeout", "abc", "api=http://127.0.0.1:1/"])).code).toBe(2);
    expect((await run(["--interval", "0", "api=http://127.0.0.1:1/"])).code).toBe(2);
    expect((await run(["api=ftp://127.0.0.1/"])).code).toBe(2);
  });
});

describe("deploy.sh restart uses readiness polling", () => {
  const deploy = readFileSync(resolve(vps, "deploy.sh"), "utf8");
  const restart = deploy.slice(deploy.indexOf("restart() {"), deploy.indexOf("\n}\n", deploy.indexOf("restart() {")));

  it("no longer assumes a fixed boot time", () => {
    expect(restart).not.toMatch(/\bsleep\s+\d/);
    expect(restart).toContain('bash "$WAIT_READY" --timeout "$READY_TIMEOUT"');
  });

  it("fails the deploy (not just warns) when services stay unhealthy or the smoke test fails", () => {
    expect(restart).toMatch(/if ! bash "\$WAIT_READY"[\s\S]*diagnose \$svc[\s\S]*die "services not ready/);
    expect(restart).toMatch(/smoke-test\.sh" \|\|\s*die "smoke test failed/);
    expect(restart).not.toMatch(/WARNING: smoke test/);
  });

  it("resolves the helper next to the running script, before any symlink switch", () => {
    expect(deploy).toMatch(/WAIT_READY="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)" && pwd -P\)\/wait-ready\.sh"/);
    expect(deploy.indexOf('[ -f "$WAIT_READY" ] || die')).toBeLessThan(deploy.indexOf('ln -sfn "$dest"'));
  });

  it("polls the readiness endpoints of exactly the ConfirmX services", () => {
    expect(deploy).toContain('confirmx-api) echo "http://127.0.0.1:4000/ready"');
    expect(deploy).toContain('confirmx-web) echo "http://127.0.0.1:3001/api/health"');
    expect(deploy).toContain('confirmx-sites) echo "http://127.0.0.1:3002/healthz"');
    // Never acts on Asterisk, Redis or Nginx (restarts only confirmx-* units).
    expect(deploy).not.toMatch(/\b(systemctl|service)\s+\w+\s+(asterisk|redis\S*|nginx)\b/i);
    expect(deploy).not.toMatch(/\/etc\/asterisk|asterisk\s+-r|redis-cli|nginx\s+-s/i);
    expect(deploy).toMatch(/SERVICES=\(confirmx-api confirmx-web confirmx-sites\)/);
  });
});
