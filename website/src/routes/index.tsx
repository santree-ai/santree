import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { Hero } from "~/components/hero/hero";

// Below-fold sections are code-split; the prerender awaits lazy chunks, so
// their HTML still lands in dist/client/index.html (CI greps assert this).
// Fallbacks carry each section's id + a rough min-height so hash anchors
// resolve and layout doesn't shift during client-side navigations.
const Loop = lazy(() => import("~/components/sections/loop").then((m) => ({ default: m.Loop })));
const FeaturesSection = lazy(() =>
  import("~/components/sections/features-section").then((m) => ({ default: m.FeaturesSection })),
);
const ParallelStrip = lazy(() =>
  import("~/components/sections/parallel-strip").then((m) => ({ default: m.ParallelStrip })),
);
const Integrations = lazy(() =>
  import("~/components/sections/integrations").then((m) => ({ default: m.Integrations })),
);
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
      <div className="divider mx-auto max-w-4xl" aria-hidden />
      <Suspense fallback={<section id="loop" className="min-h-[60vh]" />}>
        <Loop />
      </Suspense>
      <Suspense fallback={<section id="features" className="min-h-[200vh]" />}>
        <FeaturesSection />
      </Suspense>
      <Suspense fallback={<section className="min-h-[50vh]" />}>
        <ParallelStrip />
      </Suspense>
      <Suspense fallback={<section className="min-h-[28rem]" />}>
        <Integrations />
      </Suspense>
      <Suspense fallback={<section id="trust" className="min-h-[28rem]" />}>
        <Trust />
      </Suspense>
      <Suspense fallback={<section id="faq" className="min-h-[60vh]" />}>
        <Faq />
      </Suspense>
      <div className="divider mx-auto max-w-4xl" aria-hidden />
      <Suspense fallback={<section id="oss" className="min-h-[40vh]" />}>
        <FinalCta />
      </Suspense>
    </main>
  );
}
