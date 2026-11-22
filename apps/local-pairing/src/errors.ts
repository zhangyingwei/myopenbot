import { Effect, Schema } from "effect";

export class LocalPairingError extends Schema.TaggedError<LocalPairingError>()("LocalPairingError", {
  status: Schema.Number,
  code: Schema.String,
  message: Schema.String,
}) {
  constructor(status: number, code: string, message: string) {
    super({ status, code, message });
  }
}

export function fail(status: number, code: string, message: string): Effect.Effect<never, LocalPairingError> {
  return Effect.fail(new LocalPairingError(status, code, message));
}

export function internalError(): LocalPairingError {
  return new LocalPairingError(500, "internal_error", "The local pairing service failed.");
}
