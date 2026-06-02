# Installation

This repo is a project-local Pi setup for Project Flow. It is not packaged as a global Pi package yet; Pi loads the extension from `.pi/extensions/project-flow/index.ts`.

## Prerequisites

- Node.js 20+ and npm
- Git
- Pi coding agent installed globally:

```bash
npm install -g @earendil-works/pi-coding-agent
```

- At least one configured model/provider for Pi, for example via provider environment variables or Pi auth setup.

## Clone

```bash
git clone https://github.com/CGpancake/Flow.git
cd Flow
```

## Install project-local extension dependencies

The extension imports Pi types/TUI helpers and `typebox`. Install the pinned project-local npm dependencies under `.pi/npm`:

```bash
cd .pi/npm
npm install
cd ../..
```

Tracked dependency files:

- `.pi/npm/package.json`
- `.pi/npm/package-lock.json`

`node_modules/` is intentionally ignored.

## Install Pi capability packages

Project Flow uses two Pi packages as capability backends:

- `pi-web-access` — enables `web_search`, `code_search`, `fetch_content`, and `get_search_content` for research/current-docs planning.
- `pi-subagents` — enables the public `subagent` bridge for fresh-worker builds and subagent handoffs.

Install them globally for your Pi user profile:

```bash
pi install npm:pi-web-access
pi install npm:pi-subagents
```

Or install them project-locally if you want this repo to carry package settings in `.pi/settings.json`:

```bash
pi install npm:pi-web-access --local
pi install npm:pi-subagents --local
```

## Optional environment variables

Project Flow no longer hardcodes local machine paths. Configure these only if needed:

```bash
# Source project used by /reload-flow when copying extension/support files into another project
export PI_PROJECT_FLOW_DEV_ROOT="/path/to/Flow"

# Dedicated validation project; /pf-self-validate build and /pf-e2e refuse other cwd values when set
export PI_PROJECT_FLOW_VALIDATION_CWD="/path/to/Flow-test"

# Optional model routing for worker/review tasks
export PI_PROJECT_FLOW_WORKER_MODEL="provider/model-id"
export PI_PROJECT_FLOW_REVIEW_MODEL="provider/model-id"
```

Windows PowerShell equivalent:

```powershell
$env:PI_PROJECT_FLOW_DEV_ROOT = "C:\path\to\Flow"
$env:PI_PROJECT_FLOW_VALIDATION_CWD = "C:\path\to\Flow-test"
```

## Validate the setup

From the repo root:

```bash
node .pi/project-flow/self-validate.mjs
pi
```

Inside Pi, run:

```text
/pf-doctor
/pf-self-validate
```

For the confined worker smoke test, run this only in the configured validation project, or leave `PI_PROJECT_FLOW_VALIDATION_CWD` unset to validate the current repo:

```text
/pf-self-validate build
/pf-e2e
```

## Basic usage

Start Pi from the repo or from a target project where these `.pi` files have been copied:

```bash
pi
```

Then use:

```text
/plan <task>
/plan-continue
/doc
```

When copying this Project Flow setup into another project during development:

```text
/reload-flow
/reload
```

`/reload-flow` copies extension/support files from `PI_PROJECT_FLOW_DEV_ROOT` if set, otherwise from the current project. It does not touch project-local memory, plans, or sessions.

## What is intentionally not committed

The repository ignores local/runtime artifacts:

- `.pi/project-flow/sessions/*`
- `.pi/project-flow/plans/*`
- `.pi/project-flow/memory/*`
- `.pi/project-flow/self-test/*`
- `.pi/npm/node_modules/`

Only `.gitkeep` placeholders are committed for those runtime directories.
