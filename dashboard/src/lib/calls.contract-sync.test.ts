// Fails when `calls.ts` drifts from the contract: a method needs exactly 1 yoctoNEAR iff its body calls
// `require_owner_one_yocto()`; `require_owner()` alone means no deposit. Reads contract/src/*.rs from the repo.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NO_DEPOSIT_METHODS, ONE_YOCTO_METHODS } from "./calls";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../../contract/src");

type Kind = "one_yocto" | "no_deposit";

/** `pub fn` name -> deposit kind, for every public method that gates on the owner. */
function ownerMethods(): Map<string, Kind> {
  const out = new Map<string, Kind>();
  for (const file of readdirSync(SRC).filter((f) => f.endsWith(".rs") && f !== "tests.rs")) {
    const text = readFileSync(join(SRC, file), "utf8");
    const fns = [...text.matchAll(/(^|[^\w(])(pub\s+)?fn\s+(\w+)/g)];
    fns.forEach((m, i) => {
      if (!m[2]) return; // private helpers and pub(crate) are not contract methods
      const body = text.slice(m.index, fns[i + 1]?.index ?? text.length);
      const name = m[3]!;
      if (/self\.require_owner_one_yocto\(\)/.test(body)) out.set(name, "one_yocto");
      else if (/self\.require_owner\(\)/.test(body)) out.set(name, "no_deposit");
      else if (name === "accept_owner" && /attached_deposit\(\) == ONE_YOCTO/.test(body)) out.set(name, "one_yocto"); // proposed owner, own check
    });
  }
  return out;
}

describe("calls.ts matches contract/src", () => {
  const contract = ownerMethods();
  const one = new Set<string>(ONE_YOCTO_METHODS);
  const none = new Set<string>(NO_DEPOSIT_METHODS);

  it("finds the owner methods", () => {
    expect(contract.size).toBeGreaterThan(30);
    expect(contract.get("pin_agent")).toBe("one_yocto");
    expect(contract.get("remove_schedule")).toBe("no_deposit");
  });

  it("every owner method of the contract is in the table with the same deposit", () => {
    const problems: string[] = [];
    for (const [name, kind] of contract) {
      if (kind === "one_yocto" && !one.has(name)) problems.push(`${name}: contract needs 1 yocto, calls.ts ${none.has(name) ? "says no deposit" : "does not list it"}`);
      if (kind === "no_deposit" && !none.has(name)) problems.push(`${name}: contract needs no deposit, calls.ts ${one.has(name) ? "says 1 yocto" : "does not list it"}`);
    }
    expect(problems).toEqual([]);
  });

  it("calls.ts lists no method the contract does not have", () => {
    const stale = [...one, ...none].filter((m) => !contract.has(m));
    expect(stale).toEqual([]);
  });

  it("no method is in both lists", () => {
    expect([...one].filter((m) => none.has(m))).toEqual([]);
  });
});
