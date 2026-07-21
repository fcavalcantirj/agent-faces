// The settings-password helper: scrypt hashing (JS twin of the app's TS
// implementation) + the .env.local upsert line discipline. The PARITY test is
// the load-bearing one — it pins the two hand-kept implementations to the same
// format forever by verifying a .mjs-produced hash with the app's TS verifier.

import { describe, expect, it } from "vitest";
import { hashPassword, upsertPasswordHashLine, MIN_PASSWORD_LENGTH } from "./settings-password.mjs";
import { verifyPassword } from "@/lib/settings/env-admin";

describe("settings-password.mjs", () => {
  it("PARITY: a launcher-hashed password verifies through the app's TS verifier", () => {
    const line = hashPassword("a long enough password");
    // Colon-separated ON PURPOSE: @next/env dotenv-expansion eats $-segments
    // (a $-separated hash loaded back as "scrypt6384" — live finding 2026-07-20).
    expect(line).toMatch(/^scrypt:\d+:\d+:\d+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(line).not.toContain("$");
    expect(verifyPassword("a long enough password", line)).toBe(true);
    expect(verifyPassword("wrong password entirely", line)).toBe(false);
  });

  it("enforces the minimum length", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(() => hashPassword("short")).toThrow(/12/);
  });

  it("upsertPasswordHashLine appends when missing and replaces only its own line", () => {
    const appended = upsertPasswordHashLine("AGENT_BRIDGE_KIND=claude-code\n", "scrypt:1:1:1:a:b");
    expect(appended).toBe(
      "AGENT_BRIDGE_KIND=claude-code\nFACE_SETTINGS_PASSWORD_HASH=scrypt:1:1:1:a:b\n",
    );
    const replaced = upsertPasswordHashLine(appended, "scrypt:2:2:2:c:d");
    expect(replaced).toContain("FACE_SETTINGS_PASSWORD_HASH=scrypt:2:2:2:c:d");
    expect(replaced).not.toContain("scrypt:1:1:1:a:b");
    expect(replaced).toContain("AGENT_BRIDGE_KIND=claude-code");
    expect(replaced.match(/FACE_SETTINGS_PASSWORD_HASH=/g)).toHaveLength(1);
  });
});
