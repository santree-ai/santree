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

    // Column = longest blocker chain (memoised, cycle-guarded).
    let mut layer = vec![-1i32; n];
    let mut visiting = vec![false; n];
    for i in 0..n {
        compute_layer(i, &blockers, &mut layer, &mut visiting);
    }

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

fn compute_layer(
    i: usize,
    blockers: &[Vec<usize>],
    layer: &mut [i32],
    visiting: &mut [bool],
) -> i32 {
    if layer[i] >= 0 {
        return layer[i];
    }
    if visiting[i] {
        return 0; // break dependency cycles defensively
    }
    visiting[i] = true;
    let mut depth = 0;
    for &b in &blockers[i] {
        depth = depth.max(compute_layer(b, blockers, layer, visiting) + 1);
    }
    visiting[i] = false;
    layer[i] = depth;
    depth
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::TaskStatus;

    fn task(id: &str, project: &str, blocked_by: &[&str]) -> Task {
        Task {
            id: id.into(),
            title: id.into(),
            project: project.into(),
            status: TaskStatus::Todo,
            ready: blocked_by.is_empty(),
            blocked_by: blocked_by.iter().map(|s| (*s).into()).collect(),
            x: 0,
            y: 0,
            add_lines: 0,
            del_lines: 0,
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
}
