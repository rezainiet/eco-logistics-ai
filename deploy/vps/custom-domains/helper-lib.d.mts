// Types for helper-lib.mjs (used by the API test suite).
export declare const CERT_PREFIX: string;
export declare const MAX_ISSUES_PER_RUN: number;
export declare const RENEW_BEFORE_MS: number;
export declare const BIN: Readonly<{ certbot: string; nginx: string; systemctl: string }>;
export interface HelperPaths {
  nginxDir: string;
  webroot: string;
  letsencryptLive: string;
}
export declare const DEFAULT_PATHS: Readonly<HelperPaths>;
export declare function validHostname(h: unknown, opts?: { extraPlatformDomains?: string[] }): boolean;
export declare function certName(host: string): string;
export declare function commandAllowed(bin: string, args: string[]): boolean;
export declare function issueArgs(host: string): string[];
export declare function deleteArgs(host: string): string[];
export declare function renderNginxConfig(hosts: string[], paths?: HelperPaths): string;
export declare function issueErrorMessage(output: unknown): string;
export interface HelperResult {
  hostname: string;
  outcome: "live" | "failed";
  error?: string;
  certExpiresAt?: string;
}
export interface HelperDeps {
  fetchDesired(): Promise<{ enabled: boolean; domains: Array<{ hostname: string; action: string; issueAllowed?: boolean; retryAfter?: string | null }> } | null>;
  report(results: HelperResult[]): Promise<void>;
  run(bin: string, args: string[]): Promise<{ code: number; output: string }>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  listDir(path: string): Promise<string[]>;
  certExpiry(host: string): Promise<Date | null>;
  log(o: Record<string, unknown>): void;
  now(): Date;
  allowMassRemoval?: boolean;
}
export declare function reconcile(deps: HelperDeps, paths?: HelperPaths): Promise<{ changed: boolean; results: HelperResult[] }>;
