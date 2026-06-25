/** A translucent grouping box drawn behind the nodes of one project. */
import { Dot } from "../../components/primitives";

export interface ProjectBoxVM {
  project: string;
  left: number;
  top: number;
  width: number;
  height: number;
  color: string;
  border: string;
  bg: string;
  labelColor: string;
  opacity: number;
  count: number;
  onClick: () => void;
}

export function ProjectBox({ vm }: { vm: ProjectBoxVM }) {
  return (
    <button
      type="button"
      onClick={vm.onClick}
      className="absolute cursor-pointer rounded-[14px] text-left"
      style={{
        left: vm.left,
        top: vm.top,
        width: vm.width,
        height: vm.height,
        border: `1px solid ${vm.border}`,
        background: vm.bg,
        opacity: vm.opacity,
      }}
    >
      <div
        className="absolute top-[9px] left-[13px] flex items-center gap-[7px] text-[11px] font-semibold whitespace-nowrap"
        style={{ color: vm.labelColor }}
      >
        <Dot color={vm.color} size={7} />
        {vm.project}
        <span className="font-mono text-[9.5px] text-muted-4">{vm.count}</span>
      </div>
    </button>
  );
}
