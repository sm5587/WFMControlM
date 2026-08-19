// ============================================================
// Best-effort sensitive-data cleanup for Node.js
//
// JavaScript strings are immutable and cannot be zeroed in the
// V8 heap. We minimize exposure by:
//   - wiping mutable Buffers after crypto operations
//   - deleting sensitive child-process env vars as soon as they
//     are no longer needed
// ============================================================

/** Env vars that may carry DB2 credentials for the java connector child. */
export const DB2_CONNECTOR_SECRET_ENV_KEYS = [
  'DB2_PASS_OVERRIDE',
] as const;

/** Best-effort zero-fill of a mutable Buffer. No-op for non-Buffers. */
export function wipeBuffer(buf: Buffer | undefined | null): void {
  if (buf && Buffer.isBuffer(buf)) {
    buf.fill(0);
  }
}

/** Remove sensitive keys from a child-process env object. */
export function clearSensitiveEnvVars(
  env: NodeJS.ProcessEnv,
  keys: readonly string[] = DB2_CONNECTOR_SECRET_ENV_KEYS,
): void {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      delete env[key];
    }
  }
}
