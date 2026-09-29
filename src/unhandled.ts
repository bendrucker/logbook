// The compiler rules this case out, so reaching it means a value crossed an
// unchecked boundary, such as a row or a response, with a member the switch
// doesn't name.
export function unhandled(value: never): Error {
  return new Error(`unhandled case: ${JSON.stringify(value)}`);
}
