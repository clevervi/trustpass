import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { cache } from "react";
import { resolvePassportOrigin } from "@/lib/passport-origin";
import { encodeQr, passportUrl, type QrCode } from "@/lib/qr";
import {
  describeCategory,
  describeClaim,
  describeHistoryEntry,
  describeOrigin,
  describeStatus,
  type Tone,
} from "../claim-wording";
import { fetchPassport, type PassportView } from "../passport";

export const dynamic = "force-dynamic";

/**
 * One request per page view. `generateMetadata` and the page both need the
 * passport, and with `no-store` Next does not deduplicate the fetch on its own.
 */
const loadPassport = cache((trustpassId: string) => fetchPassport(trustpassId));

/**
 * Passports are never indexed. ADR 0004 keeps the identifier space
 * unenumerable; a search engine listing passports would enumerate it without
 * guessing a single code.
 *
 * Deliberately not paired with a robots.txt disallow: a crawler blocked by
 * robots.txt never fetches the page, never sees this directive, and can still
 * list the URL if something links to it.
 */
const NOT_INDEXED: Metadata["robots"] = { index: false, follow: false };

export async function generateMetadata({
  params,
}: PageProps<"/trustpass/[trustpassId]">): Promise<Metadata> {
  const { trustpassId } = await params;
  const result = await loadPassport(trustpassId);

  if (result.outcome !== "found") {
    return { title: "Passport", robots: NOT_INDEXED };
  }

  const { brand, model } = result.passport;

  // A link pasted into a chat unfurls into this and nothing else: no serial, no
  // issuer, no status that could go stale in someone's message history.
  return {
    title: `${brand} ${model}`,
    description: "What TrustPass has verified about this product, and what it has not.",
    robots: NOT_INDEXED,
    openGraph: {
      title: `${brand} ${model} · TrustPass`,
      description: "What TrustPass has verified about this product, and what it has not.",
    },
  };
}

const TONE_TEXT: Readonly<Record<Tone, string>> = {
  positive: "text-emerald-700 dark:text-emerald-400",
  neutral: "text-black/60 dark:text-white/60",
  caution: "text-amber-700 dark:text-amber-400",
  negative: "text-red-700 dark:text-red-400",
};

const TONE_DOT: Readonly<Record<Tone, string>> = {
  positive: "bg-emerald-500",
  neutral: "bg-black/25 dark:bg-white/25",
  caution: "bg-amber-500",
  negative: "bg-red-500",
};

const BANNER: Readonly<Record<"caution" | "negative", string>> = {
  caution: "border-amber-600/30 bg-amber-500/10 text-amber-900 dark:text-amber-100",
  negative: "border-red-600/30 bg-red-500/10 text-red-900 dark:text-red-100",
};

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function formatDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  // UTC, because the API sends a UTC date. Formatting it in a local zone would
  // shift it by a day for readers west of Greenwich.
  return new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" }).format(date);
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-16">
      {children}
    </main>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-xs uppercase tracking-[0.2em] text-black/40 dark:text-white/40">
      {children}
    </p>
  );
}

function Card({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={id}
      className="rounded-xl border border-black/10 p-6 dark:border-white/10"
    >
      <h2 id={id} className="mb-2 text-sm font-medium">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, children, note }: { label: string; children: ReactNode; note?: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-black/10 py-3 last:border-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6 dark:border-white/10">
      <dt className="text-sm text-black/60 dark:text-white/60">{label}</dt>
      <dd className="text-sm sm:text-right">
        {children}
        {note ? (
          <span className="mt-0.5 block text-xs text-black/50 dark:text-white/50">{note}</span>
        ) : null}
      </dd>
    </div>
  );
}

function Banner({
  tone,
  title,
  children,
}: {
  tone: "caution" | "negative";
  title: string;
  children: ReactNode;
}) {
  return (
    <div role="note" className={`rounded-xl border p-5 ${BANNER[tone]}`}>
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm opacity-90">{children}</p>
    </div>
  );
}

function Warnings({ passport }: { passport: PassportView }) {
  const warnings: ReactNode[] = [];

  // These invert what the rest of the page means, so they sit above it rather
  // than as one quiet row among many.
  if (passport.status === "suspended") {
    warnings.push(
      <Banner key="product-suspended" tone="negative" title="This product is suspended">
        Something has been reported about this specific unit — a fraud flag, a theft report or a
        disputed claim. Do not treat this passport as a clean record.
      </Banner>,
    );
  }

  if (passport.status === "retired") {
    warnings.push(
      <Banner key="product-retired" tone="caution" title="This product has been retired">
        It has reached the end of its registered life. Its serial has been released and may belong
        to a replacement unit.
      </Banner>,
    );
  }

  if (passport.issuer === null) {
    warnings.push(
      <Banner key="no-issuer" tone="caution" title="No business registered this product">
        Somebody who had the product opened this record. Nothing here comes from a manufacturer, a
        distributor or a shop, and nobody has vouched for it.
      </Banner>,
    );
  }

  if (passport.issuer?.verificationStatus === "unverified") {
    warnings.push(
      <Banner key="issuer-unverified" tone="caution" title="Nobody has verified this issuer">
        Everything below is the issuer&apos;s own word. TrustPass has not confirmed the company
        exists.
      </Banner>,
    );
  }

  if (passport.issuer?.verificationStatus === "suspended") {
    warnings.push(
      <Banner
        key="issuer-suspended"
        tone="negative"
        title="Trust in this issuer has been withdrawn"
      >
        TrustPass previously verified this company and no longer does. Treat what it registered with
        caution.
      </Banner>,
    );
  }

  return warnings.length > 0 ? <div className="flex flex-col gap-3">{warnings}</div> : null;
}

function Passport({ passport }: { passport: PassportView }) {
  const status = describeStatus(passport.status);

  return (
    <Shell>
      <header className="space-y-3">
        <Eyebrow>TrustPass passport</Eyebrow>
        <h1 className="text-balance text-3xl font-semibold tracking-tight">
          {passport.brand} {passport.model}
        </h1>
        <p className="break-all font-mono text-sm text-black/60 dark:text-white/60">
          {passport.trustpassId}
        </p>
      </header>

      <Warnings passport={passport} />

      <Card title="Product" id="product">
        <dl>
          <Row label="Category">{describeCategory(passport.category)}</Row>
          <Row label="Status">
            <span className={TONE_TEXT[status.tone]}>{status.label}</span>
          </Row>
          {passport.serial ? (
            <Row
              label="Serial number"
              note={`${passport.serial.hiddenCharacters} characters withheld. Compare the last four with the label.`}
            >
              <span className="font-mono">••••{passport.serial.suffix}</span>
            </Row>
          ) : (
            <Row label="Serial number" note="Too short to show any part of it safely.">
              <span className="text-black/60 dark:text-white/60">Not shown</span>
            </Row>
          )}
          <Row label="Registered on">{formatDate(passport.registeredOn)}</Row>
          {passport.origin ? (
            <Row label="Record started" note={describeOrigin(passport.origin).detail}>
              {describeOrigin(passport.origin).label}
            </Row>
          ) : null}
        </dl>
      </Card>

      {/*
        No panel at all when there is no issuer, rather than one with blanks in
        it. An empty Issuer card reads as an issuer whose details are missing,
        which is a different claim from there being none — and the warning above
        has already said which.
      */}
      {passport.issuer ? (
        <Card title="Issuer" id="issuer">
          <dl>
            <Row label="Company">{passport.issuer.companyName}</Row>
            <Row label="Country">{countryName(passport.issuer.country)}</Row>
            <Row
              label="Registration number"
              note="You can check this yourself in the national business registry."
            >
              <span className="font-mono">{passport.issuer.registrationNumber}</span>
            </Row>
          </dl>
        </Card>
      ) : null}

      <Card title="What has been checked" id="checks">
        <ol className="flex flex-col">
          {passport.claims.map(({ claim, state }) => {
            const wording = describeClaim(claim, state);

            return (
              <li
                key={claim}
                className="border-b border-black/10 py-3 last:border-0 dark:border-white/10"
              >
                <div className="flex items-baseline justify-between gap-6">
                  <span className="text-sm">{wording.subject}</span>
                  <span className={`flex items-center gap-2 text-sm ${TONE_TEXT[wording.tone]}`}>
                    <span
                      aria-hidden="true"
                      className={`inline-block size-2 shrink-0 rounded-full ${TONE_DOT[wording.tone]}`}
                    />
                    {wording.label}
                  </span>
                </div>
                {wording.detail ? (
                  <p className="mt-1 text-xs text-black/50 dark:text-white/50">{wording.detail}</p>
                ) : null}
              </li>
            );
          })}
        </ol>
      </Card>

      <History passport={passport} />

      <PassportQr trustpassId={passport.trustpassId} />

      <p className="text-balance text-xs text-black/50 dark:text-white/50">
        A TrustPass passport records who made each claim about a product and what TrustPass has
        checked. It is not a certificate of authenticity.
      </p>
    </Shell>
  );
}

/**
 * What has been recorded about this product.
 *
 * Every entry is worded as a report, never as a finding. A suspension carrying
 * reason `theft_report` reads "a theft was reported"; it does not read "stolen"
 * and it does not get a red badge. Colouring a report as a verdict would do
 * with styling exactly what the wording refuses to do with words, and would
 * accuse a seller on the strength of one unverified filing.
 */
function History({ passport }: { passport: PassportView }) {
  const history = passport.history ?? [];

  // No section at all rather than an empty one. A heading over nothing invites
  // the reading that nothing has happened, when what is true is that nothing
  // was recorded — and those are different facts.
  if (history.length === 0) return null;

  const earliest = history[history.length - 1];

  return (
    <Card title="What has been recorded" id="history">
      <ol className="flex flex-col">
        {history.map((entry) => {
          const wording = describeHistoryEntry(entry.type, entry.reason, entry.actorKind);
          const learnedLater = entry.recordedOn !== entry.occurredOn;

          return (
            <li
              // Composed from the entry rather than its index. Two entries
              // alike in every field are indistinguishable to a reader anyway,
              // so a collision there changes nothing they can see.
              key={`${entry.type}-${entry.occurredOn}-${entry.recordedOn}-${entry.reason ?? ""}-${entry.actorKind}`}
              className="border-b border-black/10 py-3 last:border-0 dark:border-white/10"
            >
              <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
                <span className={`text-sm ${TONE_TEXT[wording.tone]}`}>{wording.title}</span>
                <span className="shrink-0 font-mono text-xs text-black/50 dark:text-white/50">
                  {formatDate(entry.occurredOn)}
                </span>
              </div>

              <p className="mt-1 text-xs text-black/60 dark:text-white/60">
                Recorded by {wording.actor}
                {wording.because ? <> because {wording.because}</> : null}.
              </p>

              {learnedLater ? (
                /*
                  Both dates, and no judgement about the gap. ADR 0008 as
                  amended: a late record may be the one backed by a document,
                  and an immediate one may be a seller's unchecked word. The
                  page shows the distance and lets the reader weigh it.
                */
                <p className="mt-0.5 text-xs text-black/40 dark:text-white/40">
                  Reported to have happened on {formatDate(entry.occurredOn)}; recorded by TrustPass
                  on {formatDate(entry.recordedOn)}.
                </p>
              ) : null}
            </li>
          );
        })}

        {/*
          The unknown period, stated rather than left blank.

          Per ADR 0007 as amended, what began is TrustPass's record, not the
          product. The gap belongs to this system's knowledge, and a history
          that simply stopped would read as though the product had no earlier
          life.
        */}
        <li className="pt-3 text-xs text-black/50 dark:text-white/50">
          Before {earliest ? formatDate(earliest.occurredOn) : "this record"}, nothing is known to
          TrustPass. The product existed; this system did not have a record of it.
        </li>
      </ol>
    </Card>
  );
}

/**
 * The passport's own QR, rendered server-side as SVG elements.
 *
 * Not `dangerouslySetInnerHTML` over an SVG string: the path is data, and React
 * can take data. Not an `<img>` either, which would cost a second request for
 * something already computed here.
 */
async function PassportQr({ trustpassId }: { trustpassId: string }) {
  const origin = resolvePassportOrigin({ host: (await headers()).get("host") });

  // No origin, no QR — and the rest of the passport is unaffected. Everything
  // else on this page is still true; a code pointing at the wrong host would
  // not be, and it would be the one part a reader acts on.
  if (origin.kind === "unknown") {
    return null;
  }

  let code: QrCode;
  try {
    code = encodeQr(passportUrl(trustpassId, origin.baseUrl));
  } catch {
    // The encoder refuses anything it would corrupt. A passport that rendered
    // is proof the identifier is well formed, so this is unreachable in
    // practice — but a thrown error here would replace a valid passport with an
    // error page, and a missing QR is a far smaller loss than a missing
    // passport.
    return null;
  }

  return (
    <Card title="Scan or share" id="qr">
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-6">
        {/*
          Black on white in both colour schemes, deliberately. An inverted QR —
          light modules on a dark background — is rejected by a large share of
          scanners, so this is the one element on the page that must ignore dark
          mode.
        */}
        <svg
          viewBox={`0 0 ${code.extent} ${code.extent}`}
          className="size-40 shrink-0 rounded-lg bg-white"
          shapeRendering="crispEdges"
          role="img"
          aria-label="QR code linking to this passport"
        >
          <title>QR code linking to this passport</title>
          <path d={code.path} fill="#000" />
        </svg>

        <div className="space-y-2 text-center sm:text-left">
          <p className="text-sm text-black/70 dark:text-white/70">
            This code points at this page and nothing else.
          </p>
          {/*
            Said here rather than left implied. A QR can be photographed from a
            marketplace listing and reprinted onto any object, so a successful
            scan is evidence that someone had the code — not evidence about the
            object in your hands. ADR 0003.
          */}
          <p className="text-xs text-black/50 dark:text-white/50">
            Scanning it proves only that someone had the code. A QR can be copied from a photograph
            onto any object.
          </p>
          <a
            href={`/trustpass/${encodeURIComponent(trustpassId)}/qr.svg`}
            className="inline-block text-xs underline underline-offset-4 opacity-70 hover:opacity-100"
            download={`${trustpassId}.svg`}
          >
            Download as SVG
          </a>
        </div>
      </div>
    </Card>
  );
}

function Unreadable({
  trustpassId,
  reason,
}: {
  trustpassId: string;
  reason: "mistyped" | "malformed";
}) {
  return (
    <Shell>
      <header className="space-y-3">
        <Eyebrow>TrustPass passport</Eyebrow>
        <h1 className="text-3xl font-semibold tracking-tight">
          {reason === "mistyped" ? "This code has a typo" : "This isn't a TrustPass code"}
        </h1>
      </header>

      <p className="break-all rounded-xl border border-black/10 p-4 font-mono text-sm dark:border-white/10">
        {trustpassId.slice(0, 64)}
      </p>

      {reason === "mistyped" ? (
        <p className="text-balance text-black/70 dark:text-white/70">
          Its check character doesn&apos;t match, which almost always means one character was
          misread or mistyped. Compare it with the label character by character.{" "}
          <strong className="font-medium">This does not mean the product is unregistered</strong> —
          nothing has been looked up yet.
        </p>
      ) : (
        <p className="text-balance text-black/70 dark:text-white/70">
          TrustPass codes start with <span className="font-mono">TP1-</span> followed by 27
          characters. Check that you scanned or copied the right code.
        </p>
      )}
    </Shell>
  );
}

function Unavailable() {
  return (
    <Shell>
      <header className="space-y-3">
        <Eyebrow>TrustPass passport</Eyebrow>
        <h1 className="text-3xl font-semibold tracking-tight">We couldn&apos;t check this code</h1>
      </header>
      <p className="text-balance text-black/70 dark:text-white/70">
        TrustPass could not be reached. Try again shortly.{" "}
        <strong className="font-medium">No check has been made</strong>, so nothing about this
        product — good or bad — should be read from this page.
      </p>
    </Shell>
  );
}

export default async function PassportPage({ params }: PageProps<"/trustpass/[trustpassId]">) {
  const { trustpassId } = await params;
  const result = await loadPassport(trustpassId);

  // notFound() works by throwing, so it must not sit inside a try. The fetch
  // module returns a union instead of throwing for exactly that reason.
  //
  // Known limitation, measured against a production build rather than assumed:
  // Next 16.3.5 answers 404 but does not server-render the not-found boundary
  // into the HTML — the body arrives as an empty Suspense placeholder and the
  // copy is rendered on the client from the Flight payload. Verified to be
  // independent of `force-dynamic` and of whether the boundary sits in this
  // segment or at the app root. A reader without JavaScript therefore sees a
  // blank 404 rather than the sentence in `not-found.tsx`. Tracked as #38.
  if (result.outcome === "not_found") {
    notFound();
  }

  // A typo and an outage render here, at 200, rather than as a 404. A 404 is the
  // system asserting nothing is here — for a mistyped code that is agreeing the
  // product is unregistered, the false accusation ADR 0004's check symbol exists
  // to prevent.
  if (result.outcome === "unreadable") {
    return <Unreadable trustpassId={trustpassId} reason={result.reason} />;
  }

  if (result.outcome === "unavailable") {
    return <Unavailable />;
  }

  return <Passport passport={result.passport} />;
}
