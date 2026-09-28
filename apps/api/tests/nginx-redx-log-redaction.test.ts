import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * RedX authenticates webhooks with ?token=<secret> in the URL (official
 * docs). The production Nginx template must keep that token out of the
 * access and error logs without touching logging for anything else.
 * (Behaviour was verified with the real Nginx 1.24 binary in Phase 1.3;
 * this test pins the template so the protection cannot silently regress.)
 */
const here = fileURLToPath(new URL(".", import.meta.url));
const conf = readFileSync(resolve(here, "../../../deploy/vps/nginx/confirmx.conf"), "utf8");

function block(startPattern: RegExp): string {
  const start = conf.search(startPattern);
  expect(start, String(startPattern)).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = conf.indexOf("{", start); i < conf.length; i++) {
    if (conf[i] === "{") depth++;
    if (conf[i] === "}" && --depth === 0) return conf.slice(start, i + 1);
  }
  throw new Error("unbalanced block");
}

describe("nginx template: RedX webhook token never reaches the logs", () => {
  const format = /log_format\s+confirmx_noquery\s+([\s\S]*?);/.exec(conf)?.[1] ?? "";
  const api = block(/server\s*\{[^}]*server_name api\.confirmx\.ai;/);
  const redx = block(/location \^~ \/api\/webhooks\/courier\/redx\//);

  it("defines a query-less log format", () => {
    expect(format).toContain("$uri");
    for (const leaky of ["$request ", '$request"', "$request_uri", "$args", "$query_string", "$arg_", "$is_args"]) {
      expect(format).not.toContain(leaky);
    }
  });

  it("the RedX webhook location lives in the API server and uses it, with normal proxying", () => {
    expect(api).toContain(redx);
    expect(redx).toMatch(/access_log\s+\/var\/log\/nginx\/access\.log\s+confirmx_noquery;/);
    expect(redx).toMatch(/error_log\s+\S+\s+crit;/);
    expect(redx).toContain("proxy_pass http://confirmx_api;");
    expect(redx).toContain("include /etc/nginx/snippets/confirmx-proxy.conf;");
  });

  it("everything else keeps default logging (nothing disabled, no other override)", () => {
    expect(conf).not.toMatch(/access_log\s+off/);
    expect(conf.match(/access_log\s/g)).toHaveLength(1);
    expect(api).toMatch(/location \/ \{\s*proxy_pass http:\/\/confirmx_api;/);
  });
});
