# Study Design and Power Analysis Planner

Browser-based planning tool for HCI studies with a focus on a-priori power analysis, sample-size planning, study-design guidance, and placeholder data generation.

## What the tool does

The planner lets users:

- define independent variables (IVs) and dependent variables (DVs)
- build between-subject, within-subject, mixed, t-test, and regression scenarios
- estimate effect sizes from means and pooled standard deviation or direct effect-size input
- compute a-priori sample sizes directly in JavaScript in the browser
- inspect `Minimum N` and design-aligned `Required N`
- choose a controlling effect for ANOVA-based sample-size recommendations
- view formulas, charts, and placeholder data tables for reporting and analysis preparation

## Supported analyses

The current browser engine focuses on:

- one-way between ANOVA
- one-way repeated-measures ANOVA
- mixed ANOVA interaction (`within-between interaction`)
- general factorial ANOVA overview rows
- independent two-sample t-tests
- paired t-tests
- multiple regression

## Exact power formulas

The JavaScript power engine now uses explicit noncentral F and noncentral t based calculations for the primary a-priori cases instead of relying only on broad heuristics.

Implemented exact paths include:

- `estimateSampleSizeOneWayBetweenExact(...)`
- `estimatePowerOneWayBetweenExact(...)`
- `estimateSampleSizeOneWayWithinExact(...)`
- `estimatePowerOneWayWithinExact(...)`
- `estimateSampleSizeMixedInteractionExact(...)`
- `estimatePowerMixedInteractionExact(...)`

These functions are exported through:

- `window.StudyPowerEngine`
- `window.PowerEngine`

## Sample-size concepts

The UI distinguishes between:

- `Minimum N`: the smallest sample size that reaches the target power for the selected effect
- `Required N`: the smallest design-compatible sample size after rounding to the current design sequence multiple

The analysis view is driven by the `Required N` of the currently selected controlling effect.

## Project structure

- [index.html](./index.html): static application shell
- [_js/planner-app.js](./_js/planner-app.js): UI flow, rendering, study-design handling, chart setup
- [_js/power-engine.js](./_js/power-engine.js): browser-side statistical engine
- [_css/style.css](./_css/style.css): styling and responsive layout

## Local usage

No build step is required. Open `index.html` in a browser or serve the folder with a lightweight static server.

## Notes for contributors

- The UI is intentionally dependency-light.
- `testdata/` and the local Superpower source are not meant to ship in the public repository.
- Please preserve the browser API surface used by the site, especially `window.StudyPowerEngine`.
