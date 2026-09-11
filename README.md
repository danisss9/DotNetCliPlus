# DotNet CLI Plus

dotnet CLI commands, project/solution management, NuGet tools and project templates for VS Code — a **free companion to the base C# extension** (`ms-dotnettools.csharp`) that covers the workflow features normally gated behind the C# Dev Kit: no sign-in, no license, works in VS Code forks.

## Requirements

- .NET SDK (`dotnet`) on PATH — SDK-style projects (.NET Core 3.1+ / .NET 5+)
- The [C# extension](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csharp) for language features and debugging (recommended automatically)

## Keyboard shortcuts

All commands are bound to `Ctrl+Shift+D` chords (macOS: `Cmd+Shift+D`).

> Note: `Ctrl+Shift+D` normally opens VS Code's Run and Debug view. With this extension installed the chord takes priority; the Run view stays available from the activity bar and the Command Palette.

| Chord              | Command                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `Ctrl+Shift+D R`   | .NET: Run Project                                                                                 |
| `Ctrl+Shift+D D`   | .NET: Debug Project (generates/updates launch.json, builds, launches coreclr)                     |
| `Ctrl+Shift+D W`   | .NET: Watch Project (hot reload via dotnet watch)                                                 |
| `Ctrl+Shift+D B`   | .NET: Build                                                                                       |
| `Ctrl+Shift+D H`   | .NET: Rebuild (clean + build in one pass)                                                         |
| `Ctrl+Shift+D X`   | .NET: Clean (deletes bin/obj build artifacts)                                                     |
| `Ctrl+Shift+D T`   | .NET: Test (with vstest filter support)                                                           |
| `Ctrl+Shift+D F`   | .NET: Format (dotnet format — check or apply)                                                     |
| `Ctrl+Shift+D S`   | .NET: Restore                                                                                     |
| `Ctrl+Shift+D N`   | .NET: New Project… (full template wizard over `dotnet new list`)                                  |
| `Ctrl+Shift+D P`   | NuGet: Manage Packages (search / add / update / remove)                                           |
| `Ctrl+Shift+D U`   | .NET: Update Packages (outdated packages webview)                                                 |
| `Ctrl+Shift+D M`   | .NET: Manage Solution (new / add / remove / list / migrate to .slnx)                              |
| `Ctrl+Shift+D E`   | .NET: Check Build Errors (webview with AI auto-fix)                                               |
| `Ctrl+Shift+D L`   | .NET: Run Launch Profile (launchSettings.json)                                                    |
| `Ctrl+Shift+D G`   | .NET: User Secrets (init / set / list / remove / open)                                            |
| `Ctrl+Shift+D K`   | .NET: Manage SDKs (list / sdk check / pin global.json)                                            |
| `Ctrl+Shift+D A`   | .NET: Setup NuGet Auth (private feed credentials)                                                 |
| `Ctrl+Shift+D J`   | .NET: Manage Config Files (gitignore / editorconfig / global.json / nuget.config / NuGet sources) |
| `Ctrl+Shift+D O`   | .NET: Publish / Pack                                                                              |
| `Ctrl+Shift+D Tab` | .NET: Switch File (code-behind ↔ markup, source ↔ tests)                                          |
| `Ctrl+Shift+D C`   | Close Terminals                                                                                   |
| `Ctrl+Shift+D I`   | .NET: Add Project Reference (with circular-reference detection)                                   |
| `Ctrl+Shift+D Y`   | .NET: Remove Project Reference                                                                    |
| `Ctrl+Shift+D Q`   | .NET: List Project References                                                                     |
| `Ctrl+Shift+D Z`   | NuGet: Dependency Graph (workspace package tree webview)                                          |
| `Ctrl+Shift+D V`   | NuGet: Security Scan (package security review)                                                    |
| `Ctrl+Shift+D 1`   | .NET: Refresh Tests (re-run test discovery)                                                       |
| `Ctrl+Shift+D 0`   | .NET: Clear Coverage Baseline (resets the coverage diff)                                          |

Every command is also available in the Command Palette under the **DotNet CLI Plus** category, via the status bar item, and for folders through the **.NET New** explorer context submenu (console, classlib, xunit/NUnit/MSTest, Web API, Blazor, worker, gRPC, config files…).

## Features

- **Solution & project aware** — discovers `.sln`/`.slnx` files (falls back to standalone `.csproj`), parses projects directly, and offers smart pickers with _Current project_ / _Last used_ context rows
- **Solution Explorer** — tree view in the Explorer sidebar (solutions → solution folders → projects → project/package references) with type-aware icons, broken-reference flags and context-menu actions that run directly on the selected node (Run / Debug / Watch, Build / Clean / Test / Format, Manage Packages, Add/Remove Reference, User Secrets, Publish); refreshes automatically when solution or project files change
- **Test Explorer** — Testing view populated from `dotnet test --list-tests` (project → namespace → class → test), with Run, Debug and Coverage profiles; TRX results, failure messages/stack traces, per-line coverage gutters and the built-in Coverage view. Microsoft.Testing.Platform projects (xUnit v3 native mode, without `Microsoft.NET.Test.Sdk`) are supported natively via `dotnet run -- --list-tests` / `--report-trx` / `--coverage`. Coverage runs print aggregate line/branch totals, enforce optional thresholds and diff against the previous run
- **Terminal lifecycle management** — tracked, reused terminals; restart prompts for long-running commands; exit-code toasts with Retry
- **NuGet management** — package search with version picker, outdated-package webview with per-project batch updates, add/remove/list
- **Project references** — add (with circular-reference detection), remove, list
- **AI auto-fix** — build errors open in a webview with one-click fixes via GitHub Copilot Chat or Claude Code (clipboard fallback)
- **Branch-switch restore check** — watches `.git/HEAD` and offers `dotnet restore` when solution/project files change
- **SDK health** — verifies `dotnet` availability and `global.json` SDK pinning on startup
- **C# snippets** — prop, ctor, cw, xunit fact/theory, MSTest/NUnit tests, dispose pattern and more

## Settings (`dotnetCliPlus.*`)

| Setting                       | Default   | Description                                                            |
| ----------------------------- | --------- | ---------------------------------------------------------------------- |
| `build.configuration`         | `default` | Configuration for dotnet build                                         |
| `run.configuration`           | `default` | Configuration for dotnet run                                           |
| `watch.mode`                  | `run`     | Default watch mode (run/build/test)                                    |
| `test.noBuild`                | `false`   | Pass --no-build to dotnet test                                         |
| `testExplorer.enabled`        | `true`    | Populate the Testing view with Run / Debug / Coverage profiles         |
| `testExplorer.locateInSource` | `true`    | Attach source locations to discovered tests (heuristic attribute scan) |
| `coverage.threshold.line`     | `0`       | Minimum aggregate line coverage % for the Coverage profile (0 = off)  |
| `coverage.threshold.branch`   | `0`       | Minimum aggregate branch coverage % for the Coverage profile (0 = off) |
| `newProject.outputRoot`       | `""`      | Default output dir for the New Project wizard                          |
| `newProject.addToSolution`    | `true`    | Offer `dotnet sln add` after creating projects                         |
| `nuget.prerelease`            | `false`   | Include prerelease versions in package search                          |
| `publish.configuration`       | `release` | Default configuration for publish/pack                                 |
| `restoreCheck.enabled`        | `true`    | Offer restore after git branch switches                                |
| `sdk.checkOnStartup`          | `true`    | Check dotnet availability + global.json on startup                     |
| `ai.provider`                 | `copilot` | AI assistant for auto-fix (copilot/claude)                             |
| `ai.autoFixEnabled`           | `true`    | Show Auto Fix buttons in webviews                                      |

## NuGet dependency graph and security scan

Open **NuGet: Dependency Graph** from the Command Palette or the Solution Explorer toolbar. Select a workspace in multi-root windows. The graph includes C#, F# and VB projects, project references, direct and transitive NuGet packages, and separate target-framework/runtime branches. Search reveals the path to nested packages; expand/collapse, Expand all, Fit, Reset, pan and zoom work without animated layout settling. The graph also links directly to **NuGet: Security Scan**.

The graph reads `project.assets.json` from the last restore. This includes resolved central package versions. Run **.NET: Restore** after dependency changes, then Refresh. Without restore data it shows unevaluated project declarations and an explicit notice. Conventional `obj/project.assets.json` and custom asset files discoverable within the workspace are supported; excluded directories and paths outside the workspace are not searched. Legacy `packages.config` projects need migration to PackageReference for a resolved graph and scan.

**NuGet: Security Scan** reviews the selected workspace in a trusted window:

- Live NuGet advisories for direct and transitive packages, using [`dotnet list package --vulnerable --include-transitive --format json`](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-package-list). Requires SDK 7.0.200+; the scanner disables implicit restore on SDKs that support it. It respects configured NuGet audit/package sources.
- Static YARA-X checks of restored package `.props`, `.targets`, PowerShell, shell, batch, JavaScript and C# script files, including inline MSBuild tasks, encoded execution, download-and-execute commands and other suspicious indicators.
- Severity/category/search filters, dependency paths, evidence links into the NuGet cache, cancellation, rescan and a standalone HTML export.
- Automatic reviews after restores and package changes performed through this extension. Terminal operations require VS Code shell integration to report completion. New package operations invalidate in-progress results.

The first script scan downloads a pinned, SHA-256-verified YARA-X engine into extension storage (Windows x64, Linux x64/ARM64, macOS x64/ARM64). Subsequent scans reuse it. Failed downloads, unavailable feeds, missing package files, scan limits and cancellation appear in coverage; they are not reported as a clean scan. Package scripts are read as data, not run by the script scanner. Compiled assemblies/tasks and runtime downloads are outside its scope. Pattern matches require investigation and are not proof of malware. No curated NuGet malware catalog is bundled.

Settings: `dotnetCliPlus.securityReview.afterRestore.enabled` controls automatic reviews, and `dotnetCliPlus.securityReview.nugetAudit.enabled` controls live advisories. Both default to `true`; manual scans remain available when automatic reviews are disabled.

## Development

```bash
npm install
npm run compile     # type-check + lint + bundle
npm run watch       # watch mode (tsc + esbuild)
npm test            # unit tests (runs in VS Code via @vscode/test-electron)
npm run test:dependencies       # graph, inventory, audit and job lifecycle tests
npm run test:webviews           # Playwright graph/report tests; needs Chromium
npm run test:security-engine    # pinned YARA-X smoke test (may download engine)
npm run test:dotnet-integration # real restore and live advisory test; needs .NET 10/network
```

Releases are published from `dnp_*` tags via the Release workflow.

## License

MIT
