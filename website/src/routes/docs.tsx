import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/docs")({
  component: DocsStub,
  head: () => ({
    meta: [{ title: "docs — santree" }],
  }),
});

function DocsStub() {
  return (
    <main
      id="main"
      className="flex min-h-[80vh] flex-col items-center justify-center gap-6 px-6 py-32 text-center"
    >
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-2">
        Work in progress
      </p>
      <h1 className="text-4xl font-semibold tracking-[-0.02em]">docs are growing</h1>
      <p className="max-w-md text-[15px] leading-relaxed text-muted">
        The santree docs are being written alongside the first public release. Until then, the
        repository is the documentation.
      </p>
      <div className="mt-2 flex gap-3">
        <Link to="/" className="btn btn-ghost h-10 px-4 text-[13px]">
          Back home
        </Link>
        <a
          href="https://github.com/santree-ai/santree"
          className="btn btn-ghost h-10 px-4 text-[13px]"
        >
          GitHub
        </a>
      </div>
    </main>
  );
}
