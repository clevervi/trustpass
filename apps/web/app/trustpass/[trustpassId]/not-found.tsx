export default function PassportNotFound() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-black/40 dark:text-white/40">
        TrustPass passport
      </p>
      <h1 className="text-3xl font-semibold tracking-tight">No passport for this code</h1>

      <p className="text-balance text-black/70 dark:text-white/70">
        No product is registered under this code.
      </p>

      {/*
        Worth saying, because the alternative explanation is the one a worried
        buyer reaches for first. A TrustPass code carries a check character that
        catches any single mistyped character, and that failure is reported
        differently — so this code was almost certainly read correctly.
      */}
      <p className="text-balance text-sm text-black/60 dark:text-white/60">
        A single mistyped character would have been reported as a typo rather than as this, so the
        code was almost certainly read correctly. If you typed it by hand and may have changed more
        than one character, check it against the label once more.
      </p>
    </main>
  );
}
