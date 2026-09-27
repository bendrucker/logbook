import type { Clock } from "../src/sync/budget";

// Time moves only when a test advances it or the budget waits, so request
// spacing costs the suite nothing and every wait it asks for is visible.
export function fakeClock() {
  let time = 0;
  const waits: number[] = [];
  const clock: Clock = {
    now: () => time,
    wait: async (ms) => {
      waits.push(ms);
      time += ms;
    },
  };
  return {
    clock,
    waits,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
