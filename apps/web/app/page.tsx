import { readSystemStatus } from "./system-status";

export const dynamic = "force-dynamic";

function StatusRow({ label, value, healthy }: { label: string; value: string; healthy: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-black/10 py-3 last:border-0 dark:border-white/10">
      <span className="text-sm text-black/60 dark:text-white/60">{label}</span>
      <span className="flex items-center gap-2 font-mono text-sm">
        <span
          aria-hidden="true"
          className={`inline-block size-2 rounded-full ${healthy ? "bg-emerald-500" : "bg-red-500"}`}
        />
        {value}
      </span>
    </div>
  );
}

export default async function HomePage() {
  const system = await readSystemStatus();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-10 px-6 py-16">
      <header className="space-y-3">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-black/40 dark:text-white/40">
          pre-release · not deployed
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">TrustPass</h1>
        <p className="text-balance text-black/60 dark:text-white/60">
          Verifiable digital identity, warranty and lifecycle history for physical products.
        </p>
      </header>

      <section
        aria-labelledby="system-status"
        className="rounded-xl border border-black/10 p-6 dark:border-white/10"
      >
        <h2 id="system-status" className="mb-2 text-sm font-medium">
          System status
        </h2>
        <StatusRow
          label="API"
          value={system.reachable ? (system.status ?? "unknown") : "unreachable"}
          healthy={system.status === "ok"}
        />
        <StatusRow
          label="Database"
          value={system.database ?? "unknown"}
          healthy={system.database === "up"}
        />
        <StatusRow label="API version" value={system.version ?? "—"} healthy={system.reachable} />
      </section>
    </main>
  );
}
