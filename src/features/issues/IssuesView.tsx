/** The Issues tab: ticket list · dependency graph · inspector/sessions. */
import { ViewChrome } from "../../components/chrome/ViewChrome";
import { GraphCanvas } from "./GraphCanvas";
import { IssueSidebar } from "./IssueSidebar";
import { IssuesProvider } from "./model";
import { RightPanel } from "./RightPanel";

export function IssuesView() {
  return (
    <IssuesProvider>
      <ViewChrome sidebarWidth={260} sidebar={<IssueSidebar />}>
        <div className="flex min-w-0 flex-1 flex-col bg-app">
          <GraphCanvas />
        </div>
        <RightPanel />
      </ViewChrome>
    </IssuesProvider>
  );
}
