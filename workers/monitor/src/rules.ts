import { z } from "zod";

// Where an alert goes. `log` writes a structured log line and nothing else,
// which is how a new rule runs until its firing history earns it a route that
// notifies someone. Each further route is a destination `deliver` handles.
export const ROUTES = ["log"] as const;
export type Route = (typeof ROUTES)[number];

const rule = z
  .strictObject({
    name: z.string().min(1),
    metric: z.string().min(1),
    above: z.number().optional(),
    below: z.number().optional(),
    // Consecutive breaching samples before the alert opens.
    for: z.int().min(1),
    route: z.enum(ROUTES),
  })
  .refine((value) => (value.above === undefined) !== (value.below === undefined), {
    message: "a rule sets exactly one of `above` and `below`",
  });

export type Rule = z.infer<typeof rule>;

export const rules = z
  .array(rule)
  .refine((value) => new Set(value.map(({ name }) => name)).size === value.length, {
    message: "rule names are unique",
  });

export function breaches(r: Rule, value: number): boolean {
  return r.above === undefined ? value < (r.below ?? -Infinity) : value > r.above;
}
