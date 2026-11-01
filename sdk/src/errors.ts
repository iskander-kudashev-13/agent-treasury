export type SdkErrorCode =
  | "INVALID_INPUT"
  | "CONFIG"
  | "UNSUPPORTED_ASSET"
  | "NO_SIGNING_KEY"
  | "VAULT_ERROR"
  | "ONECLICK_ERROR"
  | "QUOTE_CHECK_FAILED"
  /** The signed transaction may or may not have executed. Never retry blindly; re-read vault state. */
  | "AMBIGUOUS_SUBMISSION"
  | "NOT_FOUND";

export class SdkError extends Error {
  constructor(
    readonly code: SdkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SdkError";
  }
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
