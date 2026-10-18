// Thrown before a request goes out, so a refusal costs no request.
export class RequestCapReached extends Error {
  constructor(cap: number) {
    super(`request cap reached: sent ${cap} of ${cap} this invocation`);
    this.name = "RequestCapReached";
  }
}

// What an invocation's requests came to, which a run reads before and after
// its body to count its own share. A stop on the run's own budget sends
// nothing, so `rateLimited` counts only what the upstream refused.
export interface RequestTally {
  readonly sent: number;
  readonly rateLimited: number;
}

// A source whose rate limit reports nothing on a success is bounded by a count
// per invocation, and the limit response itself is what reports the limit.
export class RequestCap implements RequestTally {
  readonly #cap: number;
  #sent = 0;
  #rateLimited = 0;

  constructor(cap: number) {
    this.#cap = cap;
  }

  get sent(): number {
    return this.#sent;
  }

  get rateLimited(): number {
    return this.#rateLimited;
  }

  admit(): void {
    if (this.#sent >= this.#cap) {
      throw new RequestCapReached(this.#cap);
    }
    this.#sent += 1;
  }

  limited(): void {
    this.#rateLimited += 1;
  }
}
