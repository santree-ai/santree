//! Dependency-graph layout.
//!
//! Linear gives us issues and their blocking relations but no coordinates. This
//! assigns each task an `(x, y)` for the graph canvas: blockers flow left → right
//! (a task sits one column right of its deepest blocker), and tasks are grouped
//! into vertical bands by project. Pure and deterministic, so it's unit-testable.

use std::collections::{HashMap, HashSet};

use crate::domain::Task;

const PAD_X: i32 = 34;
const PAD_Y: i32 = 54;
const COL_STEP: i32 = 236; // node width (212) + horizontal gap
const ROW_STEP: i32 = 156; // running-node height + vertical gap
const PROJECT_GAP: i32 = 44;

/// Assign `x`/`y` to every task in place.
pub fn layout_tasks(tasks: &mut [Task]) {
    let n = tasks.len();
    if n == 0 {
        return;
    }

    let index: HashMap<&str, usize> = tasks
        .iter()
        .enumerate()
        .map(|(i, t)| (t.id.as_str(), i))
        .collect();

    // Resolve blockers to indices, ignoring any that aren't in this set.
    let blockers: Vec<Vec<usize>> = tasks
        .iter()
        .map(|t| {
            t.blocked_by
                .iter()
                .filter_map(|b| index.get(b.as_str()).copied())
                .collect()
        })
        .collect();

    // Column = longest blocker chain.
    let layer = compute_layers(&blockers);

    // Projects as vertical bands, in first-seen order. Owned so we can mutate
    // task coordinates below without holding a borrow on `tasks`.
    let mut project_order: Vec<String> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for t in tasks.iter() {
        if seen.insert(t.project.as_str()) {
            project_order.push(t.project.clone());
        }
    }
    drop(seen);

    let mut project_top = PAD_Y;
    for project in &project_order {
        let mut members: Vec<usize> = (0..n).filter(|&i| &tasks[i].project == project).collect();
        members.sort_by_key(|&i| (layer[i], i));

        let mut next_row: HashMap<i32, i32> = HashMap::new();
        let mut max_row = 0;
        for &i in &members {
            let l = layer[i];
            let row = *next_row.get(&l).unwrap_or(&0);
            next_row.insert(l, row + 1);
            max_row = max_row.max(row);
            tasks[i].x = PAD_X + l * COL_STEP;
            tasks[i].y = project_top + row * ROW_STEP;
        }
        project_top += (max_row + 1) * ROW_STEP + PROJECT_GAP;
    }
}

/// Longest blocker chain per task — its column.
///
/// Iterative (an explicit heap stack, not recursion): the chain depth is bounded
/// only by the size of the Linear workspace, and issues arrive in arbitrary order,
/// so a dependent can be visited before its blockers and force a walk the length of
/// the whole chain. As recursion that overflows the thread stack, which under
/// `panic = "abort"` is an unrecoverable crash rather than an error.
///
/// A back-edge (Linear permits blocker cycles, including a task blocking itself)
/// contributes no depth, which breaks the cycle and leaves every task with a column.
fn compute_layers(blockers: &[Vec<usize>]) -> Vec<i32> {
    let n = blockers.len();
    let mut layer = vec![-1i32; n];
    let mut on_stack = vec![false; n];
    // (task, index of the next blocker to descend into) — an explicit DFS frame.
    let mut stack: Vec<(usize, usize)> = Vec::new();

    for root in 0..n {
        if layer[root] >= 0 {
            continue;
        }
        stack.push((root, 0));
        on_stack[root] = true;
        while let Some((i, next)) = stack.pop() {
            if let Some(&b) = blockers[i].get(next) {
                stack.push((i, next + 1));
                // Skip blockers already resolved, and back-edges (still on the
                // stack) — descending into either would loop or redo work.
                if layer[b] < 0 && !on_stack[b] {
                    stack.push((b, 0));
                    on_stack[b] = true;
                }
                continue;
            }
            // Every blocker is resolved or was cut as a back-edge (`layer < 0`,
            // contributing 0) — so this task sits one column right of the deepest.
            layer[i] = blockers[i]
                .iter()
                .map(|&b| if layer[b] >= 0 { layer[b] + 1 } else { 0 })
                .max()
                .unwrap_or(0);
            on_stack[i] = false;
        }
    }
    layer
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::TaskStatus;

    fn task(id: &str, project: &str, blocked_by: &[&str]) -> Task {
        Task {
            id: id.into(),
            title: id.into(),
            priority: crate::domain::Priority::None,
            estimate: None,
            cycle: None,
            due_date: None,
            project: project.into(),
            project_color: None,
            project_icon: None,
            project_target_date: None,
            project_milestone: None,
            parent_id: None,
            status: TaskStatus::Todo,
            ready: blocked_by.is_empty(),
            blocked_by: blocked_by.iter().map(|s| (*s).into()).collect(),
            actionable: true,
            assignee: None,
            assignee_avatar_url: None,
            x: 0,
            y: 0,
        }
    }

    #[test]
    fn blockers_sit_left_of_dependents() {
        let mut tasks = vec![
            task("A", "P", &[]),
            task("B", "P", &["A"]),
            task("C", "P", &["B"]),
        ];
        layout_tasks(&mut tasks);
        assert!(tasks[0].x < tasks[1].x, "A should be left of B");
        assert!(tasks[1].x < tasks[2].x, "B should be left of C");
    }

    #[test]
    fn projects_stack_into_separate_bands() {
        let mut tasks = vec![task("A", "P1", &[]), task("B", "P2", &[])];
        layout_tasks(&mut tasks);
        // Same column (both roots), different vertical band.
        assert_eq!(tasks[0].x, tasks[1].x);
        assert!(tasks[1].y > tasks[0].y);
    }

    #[test]
    fn tolerates_cycles_without_hanging() {
        let mut tasks = vec![task("A", "P", &["B"]), task("B", "P", &["A"])];
        layout_tasks(&mut tasks);
        // Just needs to terminate and assign coordinates.
        assert!(tasks.iter().all(|t| t.y >= PAD_Y));
    }

    /// A long blocker chain must not be bounded by the call stack: `panic = "abort"`
    /// makes a stack overflow an unrecoverable crash, so this walks a chain far
    /// deeper than any thread stack could hold as recursive frames.
    #[test]
    fn deep_blocker_chain_does_not_overflow_the_stack() {
        // Task i is blocked by i+1, so resolving task 0 has to walk the whole chain
        // before it can assign a single layer. Linear returns issues in arbitrary
        // order, so a dependent-first ordering is reachable, not contrived. As
        // recursion this aborts the process with a stack overflow.
        let n = 200_000;
        let blockers: Vec<Vec<usize>> = (0..n)
            .map(|i| if i + 1 < n { vec![i + 1] } else { vec![] })
            .collect();
        let layer = compute_layers(&blockers);
        assert_eq!(layer[n - 1], 0);
        assert_eq!(layer[0], (n - 1) as i32, "each link is one column right");
    }

    /// A task that blocks itself is a degenerate cycle: it must land in column 0,
    /// not one column right of itself.
    #[test]
    fn self_blocking_task_sits_in_the_first_column() {
        let mut tasks = vec![task("A", "P", &["A"]), task("B", "P", &["A"])];
        layout_tasks(&mut tasks);
        assert_eq!(tasks[0].x, PAD_X, "A blocks itself → still a root");
        assert_eq!(tasks[1].x, PAD_X + COL_STEP, "B is one column right of A");
    }

    /// Blockers pointing outside the fetched set (a blocker in another team, or one
    /// filtered out of this query) are unresolvable — they must not shift the task's
    /// column or drop it from the layout.
    #[test]
    fn blockers_outside_the_set_are_ignored() {
        let mut tasks = vec![task("A", "P", &["GHOST-1"]), task("B", "P", &["A"])];
        layout_tasks(&mut tasks);
        assert_eq!(tasks[0].x, PAD_X, "an unknown blocker leaves A a root");
        assert_eq!(tasks[1].x, PAD_X + COL_STEP);
    }

    /// A diamond (D blocked by B and C, both blocked by A) puts D one column right
    /// of its *deepest* blocker, not its first.
    #[test]
    fn column_follows_the_longest_blocker_chain() {
        let mut tasks = vec![
            task("D", "P", &["B", "C"]),
            task("C", "P", &["B"]),
            task("B", "P", &["A"]),
            task("A", "P", &[]),
        ];
        layout_tasks(&mut tasks);
        let x = |i: usize| tasks[i].x;
        assert_eq!(x(3), PAD_X, "A is the root");
        assert_eq!(x(2), PAD_X + COL_STEP, "B");
        assert_eq!(x(1), PAD_X + 2 * COL_STEP, "C");
        assert_eq!(
            x(0),
            PAD_X + 3 * COL_STEP,
            "D follows C, its deepest blocker"
        );
    }
}
