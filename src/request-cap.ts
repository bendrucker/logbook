// Thrown before a request goes out, so a refusal costs no request.
export class RequestCapReached extends Error {
  constructor(cap: number) {
    super(`request cap reached: sent ${cap} of ${cap} this invocation`);
    this.name = "RequestCapReached";
  }
}

// A source whose rate limit reports nothing on a success is bounded by a count
// per invocation, and the limit response itself is what reports the limit.
export class RequestCap {
  readonly #cap: number;
  #sent = 0;

  constructor(cap: number) {
    this.#cap = cap;
  }

  admit(): void {
    if (this.#sent >= this.#cap) {
      throw new RequestCapReached(this.#cap);
    }
    this.#sent += 1;
  }

  get remaining(): number {
    return this.#cap - this.#sent;
  }
}
