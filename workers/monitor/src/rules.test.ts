import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { breaches, rules } from "./rules";

const base = { name: "r", metric: "m", for: 1, route: "log" };

describe("rules", () => {
  it("parses the deployed rules", () => {
    expect(rules.parse(env.ALERT_RULES).length).toBeGreaterThan(0);
  });

  it.each([
    { name: "neither bound", value: [base] },
    { name: "both bounds", value: [{ ...base, above: 1, below: 0 }] },
    { name: "an unknown route", value: [{ ...base, above: 1, route: "pager" }] },
    {
      name: "a duplicate name",
      value: [
        { ...base, above: 1 },
        { ...base, below: 1 },
      ],
    },
  ])("refuses $name", ({ value }) => {
    expect(rules.safeParse(value).success).toBe(false);
  });
});

describe("breaches", () => {
  it("compares strictly against the bound", () => {
    const [above, below] = rules.parse([
      { ...base, name: "a", above: 10 },
      { ...base, name: "b", below: 1 },
    ]);
    expect([breaches(above!, 10), breaches(above!, 11)]).toEqual([false, true]);
    expect([breaches(below!, 1), breaches(below!, 0)]).toEqual([false, true]);
  });
});
