# sokoban-solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/GBNK619/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/GBNK619/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver. Every level this competition draws is a hallway with rooms off it, and a box pushed out of a room can never come back — so the solver splits the level into rooms, solves each room push-optimally with A* over pushes (player-reachability BFS, minimum-assignment heuristic, dead-square and frozen-block pruning, transposition table keyed on boxes plus player region), and joins the rooms with hallway walks. Fully deterministic: budgets are counted in work, never in wall-clock time.

Measured on the kit's practice set: **1,000,000** (every instance solved in exactly P* pushes: 13, 16, 29, 47, 60) in ~0.44 s for the whole set — against the house baseline plain-astar's 200,000. The same perfect score held on 7 further independently drawn sets.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=7f0qee22&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
