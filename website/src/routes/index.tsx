import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { Hero } from "~/components/hero/hero";
import { Log } from "~/components/sections/log";

// Below-fold sections are code-split; the prerender awaits lazy chunks, so
// their HTML still lands in dist/client/index.html (CI greps assert this).
// Fallbacks carry each section's id + a rough min-height so hash anchors
// resolve and layout doesn't shift during client-side navigations. The log
// is imported eagerly: it is CSS-only and the nav's first anchor.
const Trust = lazy(() => import("~/components/sections/trust").then((m) => ({ default: m.Trust })));
const Faq = lazy(() => import("~/components/sections/faq").then((m) => ({ default: m.Faq })));
const FinalCta = lazy(() =>
  import("~/components/sections/final-cta").then((m) => ({ default: m.FinalCta })),
);

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  return (
    <main id="main">
      <Hero />
      <Log />
      <Suspense fallback={<section id="trust" className="min-h-[36rem]" />}>
        <Trust />
      </Suspense>
      <Suspense fallback={<section id="faq" className="min-h-[32rem]" />}>
        <Faq />
      </Suspense>
      <Suspense fallback={<section id="download" className="min-h-[40vh]" />}>
        <FinalCta />
      </Suspense>
    </main>
  );
}
