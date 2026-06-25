import { createFileRoute } from "@tanstack/react-router";

import { ReviewsView } from "../features/reviews/ReviewsView";

export const Route = createFileRoute("/reviews")({
  component: ReviewsView,
});
