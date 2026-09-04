# Change Log

All notable changes to the "dotnet-cli-plus" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [1.0.0]

Initial release. A free, sign-in-free companion to the base C# extension (`ms-dotnettools.csharp`) that covers the solution/project workflow features normally gated behind the C# Dev Kit. All commands are available in the Command Palette under the "DotNet CLI Plus" category, via the status bar item, and through `Ctrl+Shift+D` chord keybindings.

### Added

- **Solution & project awareness.** Discovers `.sln` and `.slnx` files (falling back to standalone `*.csproj` when no solution exists), parses projects directly from the solution and project files, and offers smart pickers with *Current project* / *Last used* / *Solution* context rows that remember per-command history.
- **Build commands.** `.NET: Build` (`Ctrl+Shift+D B`), `.NET: Rebuild`, `.NET: Clean` and `.NET: Restore` (`Ctrl+Shift+D S`) against the whole solution or a single project, with configurable `-c Debug/Release` defaults and terminal reuse, exit-code notifications and Retry buttons.
- **Run & watch.** `.NET: Run Project` (`Ctrl+Shift+D R`) and `.NET: Watch Project` (`Ctrl+Shift+D W`) with run/build/test hot-reload mode selection and restart prompts for already-running terminals.
- **Debug Project** (`Ctrl+Shift+D D`). Builds the project, computes the output DLL path from the csproj (TargetFramework, AssemblyName), generates or surgically updates a `coreclr` entry in `.vscode/launch.json` (comment-preserving JSONC edits), applies launch-profile environment variables for web apps, and starts the debug session.
- **Test command** (`Ctrl+Shift+D T`). Runs `dotnet test` for the solution or a test project with vstest filter input (`FullyQualifiedName~`, `|`/`&` support) and optional `--no-build`.
- **Format command** (`Ctrl+Shift+D F`). `dotnet format` with subcommand (all/whitespace/style/analyzers) and check/apply modes; a failed check offers an "Apply Format" escalation button.
- **New Project wizard** (`Ctrl+Shift+D N`). Categorized QuickPick over the full `dotnet new list` template catalog (JSON with text-table fallback for older SDKs), name/output/TFM inputs, and an offer to add the new project to the workspace solution.
- **".NET New" explorer context submenu.** Quick generation into any folder for console, classlib, xUnit/NUnit/MSTest, Web API, ASP.NET Core Empty, Razor Pages, MVC, Blazor, worker, gRPC, plus config file templates (.gitignore, .editorconfig, global.json, nuget.config) and solutions.
- **NuGet: Manage Packages** (`Ctrl+Shift+D P`). Package search via `dotnet package search` with version picker (latest / specific / prerelease setting), update-outdated multi-select, remove, and list — per project.
- **Update Packages webview** (`Ctrl+Shift+D U`). `dotnet list package --outdated` results grouped by project with checkbox selection, per-project and bulk update buttons (executed via `dotnet add package --version`), and in-place reload.
- **Manage Solution** (`Ctrl+Shift+D M`). New solution (sln/slnx), add projects (with optional solution folder), remove projects, list projects, and `.sln` → `.slnx` migration.
- **Project references.** Add (multi-select with circular-reference detection), remove, and list project references across the workspace.
- **Check Build Errors** (`Ctrl+Shift+D E`). Headless build with MSBuild error/warning parsing into a webview grouped by project — clickable file/line navigation and per-issue/per-file AI auto-fix buttons (GitHub Copilot Chat or Claude Code, clipboard fallback).
- **Run Launch Profile** (`Ctrl+Shift+D L`). Picks projects that have `Properties/launchSettings.json`, lists their profiles (command + URL) and runs `dotnet run --launch-profile`.
- **User Secrets manager** (`Ctrl+Shift+D G`). Init, set, list (with copy-to-clipboard), remove, remove-all, and opening the secrets.json file from the user profile (created on demand).
- **Manage SDKs** (`Ctrl+Shift+D K`). Installed SDKs and runtimes lists, `dotnet sdk check` and `dotnet --info` terminals, and global.json SDK pinning. On startup the extension verifies `dotnet` is on PATH and warns when global.json pins an unavailable SDK.
- **Setup NuGet Auth** (`Ctrl+Shift+D A`). Interactive setup of an authenticated private feed with PAT credentials written to nuget.config (with overwrite confirmation).
- **Manage Config Files** (`Ctrl+Shift+D J`). Open or create .gitignore/.editorconfig/global.json/nuget.config via `dotnet new`, open Directory.Build.props / Directory.Packages.props, and manage NuGet sources (list/add/remove).
- **Publish / Pack** (`Ctrl+Shift+D O`). Publish wizard (configuration, target framework, framework-dependent/self-contained with RID picker, output directory) and `dotnet pack` with IsPackable validation.
- **Switch File** (`Ctrl+Shift+D Tab`). Jump between code-behind and markup (`.razor` ↔ `.razor.cs`/`.razor.css`, `.xaml` ↔ `.xaml.cs`, `.cshtml` ↔ `.cshtml.cs`) and between source files and their tests (`Foo.cs` ↔ `FooTests.cs`/`FooTest.cs`/`FooFacts.cs`).
- **Terminal management.** Tracked terminals named per command, restart prompts for long-running tasks, multi-select "Close Terminals" (`Ctrl+Shift+D C`) with finished terminals pre-selected, and no orphaned child processes after deactivation.
- **Branch-switch restore check.** Watches `.git/HEAD` and offers `dotnet restore` when solution/project files changed after a branch switch.
- **C# snippets.** 15 snippets: prop/propg/propfull, ctor, cw, sim, asyncm, nullcheck/argcheck guards, using, dispose pattern, and xUnit fact/theory, MSTest and NUnit test methods.
- **CI and release workflows.** Type-check, lint and VS Code integration tests on Ubuntu and Windows; marketplace publishing from `dnp_*` tags.

### Notes

- `Ctrl+Shift+D` shadows VS Code's built-in Run and Debug view toggle; extension chords take priority. The Run view remains available from the activity bar and Command Palette.
- Requires SDK-style projects (.NET Core 3.1+ / .NET 5+) and the dotnet CLI on PATH. Debugging uses the base C# extension's `coreclr` debugger.

## [0.1.0]

- Initial development version.
