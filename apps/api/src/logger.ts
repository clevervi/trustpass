type Level = "info" | "warn" | "error";

/**
 * Minimal structured logger.
 *
 * Writes one JSON object per line so that any log shipper can parse it without
 * a custom grok pattern. Deliberately not a dependency: the API only needs
 * levels and context, and stdout/stderr separation is the whole contract.
 */
function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  const line = `${JSON.stringify({
    level,
    message,
    timestamp: new Date().toISOString(),
    ...context,
  })}\n`;

  if (level === "error") {
    process.stderr.write(line);
    return;
  }

  process.stdout.write(line);
}

export const logger = {
  info: (message: string, context?: Record<string, unknown>) => emit("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => emit("error", message, context),
};
