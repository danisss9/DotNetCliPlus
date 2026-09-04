# DotNet CLI Plus

dotnet CLI commands, project/solution management, NuGet tools and project templates for VS Code — a **free companion to the base C# extension** (`ms-dotnettools.csharp`) that covers the workflow features normally gated behind the C# Dev Kit: no sign-in, no license, works in VS Code forks.

## Requirements

- .NET SDK (`dotnet`) on PATH — SDK-style projects (.NET Core 3.1+ / .NET 5+)
- The [C# extension](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csharp) for language features and debugging (recommended automatically)

## Keyboard shortcuts

All commands are bound to `Ctrl+Shift+D` chords (macOS: `Cmd+Shift+D`).

> Note: `Ctrl+Shift+D` normally opens VS Code's Run and Debug view. With this extension installed the chord takes priority; the Run view stays available from the activity bar and the Command Palette.

| Chord | Command |
|---|---|
| `Ctrl+Shift+D R` | .NET: Run Project |
| `Ctrl+Shift+D D` | .NET: Debug Project (generates/updates launch.json, builds, launches coreclr) |
| `Ctrl+Shift+D W` | .NET: Watch Project (hot reload via dotnet watch) |
| `Ctrl+Shift+D B` | .NET: Build |
| `Ctrl+Shift+D T` | .NET: Test (with vstest filter support) |
| `Ctrl+Shift+D F` | .NET: Format (dotnet format — check or apply) |
| `Ctrl+Shift+D S` | .NET: Restore |
| `Ctrl+Shift+D N` | .NET: New Project… (full template wizard over `dotnet new list`) |
| `Ctrl+Shift+D P` | NuGet: Manage Packages (search / add / update / remove) |
| `Ctrl+Shift+D U` | .NET: Update Packages (outdated packages webview) |
| `Ctrl+Shift+D M` | .NET: Manage Solution (new / add / remove / list / migrate to .slnx) |
| `Ctrl+Shift+D E` | .NET: Check Build Errors (webview with AI auto-fix) |
| `Ctrl+Shift+D L` | .NET: Run Launch Profile (launchSettings.json) |
| `Ctrl+Shift+D G` | .NET: User Secrets (init / set / list / remove / open) |
| `Ctrl+Shift+D K` | .NET: Manage SDKs (list / sdk check / pin global.json) |
| `Ctrl+Shift+D A` | .NET: Setup NuGet Auth (private feed credentials) |
| `Ctrl+Shift+D J` | .NET: Manage Config Files (gitignore / editorconfig / global.json / nuget.config / NuGet sources) |
| `Ctrl+Shift+D O` | .NET: Publish / Pack |
| `Ctrl+Shift+D Tab` | .NET: Switch File (code-behind ↔ markup, source ↔ tests) |
| `Ctrl+Shift+D C` | Close Terminals |

Every command is also available in the Command Palette under the **DotNet CLI Plus** category, via the status bar item, and for folders through the **.NET New** explorer context submenu (console, classlib, xunit/NUnit/MSTest, Web API, Blazor, worker, gRPC, config files…).

## Features

- **Solution & project aware** — discovers `.sln`/`.slnx` files (falls back to standalone `.csproj`), parses projects directly, and offers smart pickers with *Current project* / *Last used* context rows
- **Terminal lifecycle management** — tracked, reused terminals; restart prompts for long-running commands; exit-code toasts with Retry
- **NuGet management** — package search with version picker, outdated-package webview with per-project batch updates, add/remove/list
- **Project references** — add (with circular-reference detection), remove, list
- **AI auto-fix** — build errors open in a webview with one-click fixes via GitHub Copilot Chat or Claude Code (clipboard fallback)
- **Branch-switch restore check** — watches `.git/HEAD` and offers `dotnet restore` when solution/project files change
- **SDK health** — verifies `dotnet` availability and `global.json` SDK pinning on startup
- **C# snippets** — prop, ctor, cw, xunit fact/theory, MSTest/NUnit tests, dispose pattern and more

## Settings (`dotnetCliPlus.*`)

| Setting | Default | Description |
|---|---|---|
| `build.configuration` | `default` | Configuration for dotnet build |
| `run.configuration` | `default` | Configuration for dotnet run |
| `watch.mode` | `run` | Default watch mode (run/build/test) |
| `test.noBuild` | `false` | Pass --no-build to dotnet test |
| `newProject.outputRoot` | `""` | Default output dir for the New Project wizard |
| `newProject.addToSolution` | `true` | Offer `dotnet sln add` after creating projects |
| `nuget.prerelease` | `false` | Include prerelease versions in package search |
| `publish.configuration` | `release` | Default configuration for publish/pack |
| `restoreCheck.enabled` | `true` | Offer restore after git branch switches |
| `sdk.checkOnStartup` | `true` | Check dotnet availability + global.json on startup |
| `ai.provider` | `copilot` | AI assistant for auto-fix (copilot/claude) |
| `ai.autoFixEnabled` | `true` | Show Auto Fix buttons in webviews |

## Roadmap

- Solution Explorer tree view (solution → projects → references)
- Test Explorer integration (`dotnet test --list-tests`, TRX results)
- Code coverage (`--collect "XPlat Code Coverage"`)

## Development

```bash
npm install
npm run compile     # type-check + lint + bundle
npm run watch       # watch mode (tsc + esbuild)
npm test            # unit tests (runs in VS Code via @vscode/test-electron)
```

Releases are published from `dnp_*` tags via the Release workflow.

## License

MIT
