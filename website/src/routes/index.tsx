import { createFileRoute } from "@tanstack/react-router";
import { Closing, LocalFirst, Questions } from "~/components/sections/after";
import { TreeSequence } from "~/components/tree/stage";

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  return (
    <main>
      <TreeSequence />
      <LocalFirst />
      <Questions />
      <Closing />
    </main>
  );
}
