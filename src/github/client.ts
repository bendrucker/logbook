import { z } from "zod";
import { rateLimitResponse, type RateLimit } from "./schema";

const ENDPOINT = "https://api.github.com/graphql";
const USER_AGENT = "logbook (+https://github.com/bendrucker/logbook)";

// GitHub scores a query on the nodes it asks for, so a page costs more than the
// one point it reads as. Stopping with headroom leaves a run ending on a
// watermark it can resume from rather than on a 403.
export const RATE_LIMIT_FLOOR = 100;

// Raw storage exists so a normalization bug stays diagnosable against the bytes
// that caused it, which only holds if a response that fails validation is still
// archivable. Every failure after the bytes arrive therefore carries them, and
// the ingest path writes `body` to R2 whether the call returned or threw.
export class GitHubResponseError extends Error {
  readonly body: string;

  // The name is a literal per subclass rather than the constructor's own, which
  // a minified build would rename. The site branches on an error's name across
  // the service binding, where the name is all that survives.
  constructor(name: string, message: string, body: string, options?: ErrorOptions) {
    super(message, options);
    this.name = name;
    this.body = body;
  }
}

export class GitHubHttpError extends GitHubResponseError {
  readonly status: number;

  constructor(status: number, body: string) {
    super("GitHubHttpError", `GitHub GraphQL responded ${status}`, body);
    this.status = status;
  }
}

const graphqlErrors = z.array(z.object({ message: z.string(), type: z.string().optional() }));

export type GraphQLErrorEntry = z.infer<typeof graphqlErrors>[number];

export class GraphQLQueryError extends GitHubResponseError {
  readonly errors: GraphQLErrorEntry[];
  // A partial failure returns `data` and `errors` together and still reports a
  // budget, which the extractor needs to decide whether to keep going.
  readonly rateLimit: RateLimit | null;

  constructor(errors: GraphQLErrorEntry[], body: string, rateLimit: RateLimit | null) {
    super(
      "GraphQLQueryError",
      `GitHub GraphQL returned errors: ${errors.map((error) => error.message).join("; ")}`,
      body,
    );
    this.errors = errors;
    this.rateLimit = rateLimit;
  }
}

// Thrown on the response that crossed the floor rather than on the one that
// would have failed. The caller resumes from the last watermark it committed
// once `resetAt` passes, and archives this response's body in the meantime.
export class RateLimitExhausted extends GitHubResponseError {
  readonly remaining: number;
  readonly resetAt: string;

  constructor(remaining: number, resetAt: string, body: string) {
    super(
      "RateLimitExhausted",
      `GitHub GraphQL rate limit down to ${remaining}, resets at ${resetAt}`,
      body,
    );
    this.remaining = remaining;
    this.resetAt = resetAt;
  }
}

export class ResponseValidationError extends GitHubResponseError {
  constructor(message: string, body: string, cause: unknown) {
    super("ResponseValidationError", `GitHub GraphQL response did not validate: ${message}`, body, {
      cause,
    });
  }
}

// The one place a response is turned into a validated shape. Routing every
// parse through it is what keeps a schema failure archivable rather than a bare
// ZodError with the bytes already gone.
export function validate<T>(schema: z.ZodType<T>, data: unknown, body: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ResponseValidationError(parsed.error.message, body, parsed.error);
  }

  return parsed.data;
}

export interface GraphQLOptions {
  fetch?: typeof globalThis.fetch;
  endpoint?: string;
  floor?: number;
}

export interface GraphQLResponse {
  data: unknown;
  // The bytes as received. Raw storage archives these before validation, so a
  // schema bug stays diagnosable against what GitHub actually said.
  body: string;
  rateLimit: RateLimit;
}

// A request-level failure comes back as `errors` with no `data` key at all, so
// the envelope has to tolerate its absence for the check below to classify it.
const envelope = z.object({
  data: z.unknown().optional(),
  errors: graphqlErrors.optional(),
});

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new ResponseValidationError("body is not JSON", body, error);
  }
}

export async function graphql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  options: GraphQLOptions = {},
): Promise<GraphQLResponse> {
  // workerd's native fetch throws "Illegal invocation" when called with a
  // foreign `this`. An arrow wrapper keeps late binding without that risk.
  const transport = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  const response = await transport(options.endpoint ?? ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new GitHubHttpError(response.status, body);
  }

  const parsed = validate(envelope, parseJson(body), body);
  if (parsed.errors && parsed.errors.length > 0) {
    const reported = rateLimitResponse.safeParse(parsed.data);
    throw new GraphQLQueryError(
      parsed.errors,
      body,
      reported.success ? reported.data.rateLimit : null,
    );
  }

  const { rateLimit } = validate(rateLimitResponse, parsed.data, body);
  if (rateLimit.remaining < (options.floor ?? RATE_LIMIT_FLOOR)) {
    throw new RateLimitExhausted(rateLimit.remaining, rateLimit.resetAt, body);
  }

  return { data: parsed.data, body, rateLimit };
}
