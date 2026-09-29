import type { BasicType } from "hyparquet-writer";

// What a D1 value becomes in the Parquet column.
export type Cell = string | number | bigint | boolean | Date | null;

export interface LakeColumn {
  name: string;
  type: BasicType;
  cell: (value: unknown) => Cell;
}

export class LakeValueError extends Error {
  readonly column: string;

  constructor(column: string, value: unknown) {
    super(`${column} holds ${describe(value)}, which the lake has no column type for`);
    this.name = "LakeValueError";
    this.column = column;
  }
}

function describe(value: unknown): string {
  return value === null ? "null" : typeof value;
}

export function text(name: string): LakeColumn {
  return {
    name,
    type: "STRING",
    cell: (value) => {
      if (value === null || typeof value === "string") {
        return value;
      }
      throw new LakeValueError(name, value);
    },
  };
}

export function integer(name: string): LakeColumn {
  return {
    name,
    type: "INT32",
    cell: (value) => {
      if (value === null || typeof value === "number") {
        return value;
      }
      throw new LakeValueError(name, value);
    },
  };
}

// A 64-bit ID, which INT32 would overflow. The writer encodes INT64 from a
// bigint, and D1 answers with a number exact up to 2^53.
export function bigint(name: string): LakeColumn {
  return {
    name,
    type: "INT64",
    cell: (value) => {
      if (value === null) {
        return null;
      }
      if (typeof value === "number" && Number.isSafeInteger(value)) {
        return BigInt(value);
      }
      throw new LakeValueError(name, value);
    },
  };
}

// SQLite has no boolean type, so D1 answers with the 0 or 1 the column stores.
export function boolean(name: string): LakeColumn {
  return {
    name,
    type: "BOOLEAN",
    cell: (value) => {
      if (value === null) {
        return null;
      }
      if (value === 0 || value === 1) {
        return value === 1;
      }
      throw new LakeValueError(name, value);
    },
  };
}

// The writer encodes a Date as INT64 TIMESTAMP_MILLIS, which DuckDB reads as a
// timestamp with no cast. Every source's timestamps are UTC to the millisecond
// or coarser, so the epoch milliseconds carry everything the string did.
export function timestamp(name: string): LakeColumn {
  return {
    name,
    type: "TIMESTAMP",
    cell: (value) => {
      if (value === null) {
        return null;
      }
      if (typeof value !== "string") {
        throw new LakeValueError(name, value);
      }

      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        throw new LakeValueError(name, value);
      }

      return date;
    },
  };
}

// A fraction, which SQLite stores as REAL and D1 answers as a number.
export function double(name: string): LakeColumn {
  return {
    name,
    type: "DOUBLE",
    cell: (value) => {
      if (value === null || typeof value === "number") {
        return value;
      }
      throw new LakeValueError(name, value);
    },
  };
}
