/**
 * The platform repo's file tree. The hero ticket's own source lives in
 * `hero.ts`; `diff.ts` turns old and new text into patches.
 */

export interface SourceFile {
  path: string;
  oldText: string;
  newText: string;
}

/** The repo's file tree, for the Files pane and the file picker. */
export const PLATFORM_FILES = [
  ".github/workflows/ci.yml",
  ".santree/init.sh",
  "README.md",
  "db/migrations/0085_shipment_scans.sql",
  "db/migrations/0086_webhook_deliveries.sql",
  "docs/api/authentication.md",
  "docs/api/rate-limits.md",
  "docs/api/webhooks.md",
  "package.json",
  "pnpm-lock.yaml",
  "src/api/app.ts",
  "src/api/middleware/auth.ts",
  "src/api/middleware/errors.ts",
  "src/api/routes/labels.ts",
  "src/api/routes/shipments.ts",
  "src/api/routes/tracking.ts",
  "src/api/routes/webhooks.ts",
  "src/billing/plans.ts",
  "src/carriers/adapter.ts",
  "src/carriers/dhl.ts",
  "src/carriers/ups.ts",
  "src/carriers/usps.ts",
  "src/checkout/AddressForm.tsx",
  "src/checkout/useAutocomplete.ts",
  "src/db/index.ts",
  "src/events/bus.ts",
  "src/events/scanEvents.ts",
  "src/labels/LabelService.ts",
  "src/labels/pdf.ts",
  "src/lib/redis.ts",
  "src/payments/index.ts",
  "src/returns/refunds.ts",
  "src/returns/types.ts",
  "src/test/factories.ts",
  "src/tracking/eta.ts",
  "src/tracking/service.ts",
  "src/webhooks/deliver.ts",
  "src/webhooks/retryWorker.ts",
  "tsconfig.json",
  "vitest.config.ts",
];
