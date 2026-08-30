import { createFileRoute, redirect } from "@tanstack/react-router";

/** The app opens on the workspace. With nothing selected it shows the welcome
 *  surface (see `TreesView`), so there is no separate landing view to keep in
 *  step with it — every other destination is a sidebar click away. */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/trees" });
  },
});
