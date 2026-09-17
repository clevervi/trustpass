const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export interface SystemStatus {
  reachable: boolean;
  status?: "ok" | "degraded";
  version?: string;
  database?: "up" | "down";
}

/**
 * Reads the API health endpoint.
 *
 * Never throws: the landing page must still render when the API is down,
 * because "the API is down" is exactly the information the page exists to show.
 */
export async function readSystemStatus(): Promise<SystemStatus> {
  try {
    const response = await fetch(`${API_URL}/health`, { cache: "no-store" });
    const body = (await response.json()) as {
      status: "ok" | "degraded";
      version: string;
      checks: { database: "up" | "down" };
    };

    return {
      reachable: true,
      status: body.status,
      version: body.version,
      database: body.checks.database,
    };
  } catch {
    return { reachable: false };
  }
}
