// Loaded async by <LazyMotion> so the animation runtime lands in its own
// chunk — the eager bundle only carries framer-motion's tiny `m` shell.
// domAnimation covers variants/inView/hover; we don't use drag or layout
// animations (that would be domMax).
export { domAnimation as default } from "framer-motion";
