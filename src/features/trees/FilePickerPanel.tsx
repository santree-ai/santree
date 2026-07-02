/** The right-hand file picker: an All files / Changes browser. It only *picks* a
 *  file — clicking one swaps the main area to its diff/contents (see FileViewer).
 *  Resizable (drag the left edge) and collapsible (drag past the threshold or the
 *  bottom-bar "Files" toggle / ⌘L — it hides entirely when collapsed). This is
 *  the thin shell: {@link ChangesList} owns staging + the commit box, and
 *  {@link AllFilesList} owns the Material-icon file tree. */
import { EdgeResizeHandle, underlineTabStyle } from "../../components/primitives";
import { useWorktreeStatus } from "../../lib/queries";
import { useEdgeResize } from "../../lib/useEdgeResize";
import { AllFilesList } from "./AllFilesList";
import { ChangesList } from "./ChangesList";
import { type FileTab, useTrees } from "./model";

const MIN_W = 240;
const MAX_W = 560;
const DEFAULT_W = 320;

export function FilePickerPanel() {
  const {
    repo,
    activeId,
    fileTab,
    setFileTab,
    rightCollapsed,
    rightWidth,
    setRightWidth,
    toggleRightPanel,
  } = useTrees();
  const { data: status = [] } = useWorktreeStatus(repo, activeId);

  const resize = useEdgeResize({
    cssVar: "--tree-right",
    width: rightWidth,
    min: MIN_W,
    max: MAX_W,
    edge: "left",
    onCommit: setRightWidth,
    collapse: { at: 190, resetTo: DEFAULT_W, onCollapse: toggleRightPanel },
  });

  // Fully hidden when collapsed — the bottom bar's "Files" button (⌘L) brings it
  // back, so there's no need for a leftover strip/arrow.
  if (rightCollapsed) return null;

  return (
    <div
      className="relative flex flex-none flex-col border-l border-line bg-deep"
      style={{ width: `var(--tree-right, ${DEFAULT_W}px)` }}
    >
      <EdgeResizeHandle edge="left" {...resize} />
      <div className="flex h-9 flex-none items-stretch border-b border-line">
        <FileTabButton tab="all" label="All files" active={fileTab} onClick={setFileTab} />
        <FileTabButton
          tab="changes"
          label={`Changes${status.length ? ` · ${status.length}` : ""}`}
          active={fileTab}
          onClick={setFileTab}
        />
      </div>

      {fileTab === "all" ? <AllFilesList /> : <ChangesList files={status} />}
    </div>
  );
}

function FileTabButton({
  tab,
  label,
  active,
  onClick,
}: {
  tab: FileTab;
  label: string;
  active: FileTab;
  onClick: (t: FileTab) => void;
}) {
  const on = active === tab;
  return (
    <button
      type="button"
      onClick={() => onClick(tab)}
      className="flex-1 cursor-pointer border-none text-[11.5px] font-medium"
      style={underlineTabStyle(on)}
    >
      {label}
    </button>
  );
}
