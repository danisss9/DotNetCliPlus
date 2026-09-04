import * as assert from 'assert';
import * as path from 'path';
import {
  buildProgramPath,
  buildTerminalCommand,
  categorizeTemplate,
  configFlag,
  configurationLabel,
  escapeShellArg,
  extractJsonObject,
  findBestProjectForPath,
  isCodeBehindFile,
  isRunnableProject,
  markupCompanionCandidates,
  normalizePathKey,
  parseCsproj,
  parseLaunchSettingsProfiles,
  parseMsbuildIssues,
  parseNewListJson,
  parseNewListText,
  parseNuGetSourcesList,
  parsePackageListOutdatedJson,
  parsePackageSearchJson,
  parseRuntimeList,
  parseSdkList,
  parseSln,
  parseSlnx,
  quoteShellPath,
  sourceBaseForTestFile,
  testFileCandidates,
  validateCustomCommand,
  validateNuGetSourceName,
  validatePackageId,
  validateProjectName,
  validateTestFilter,
  countErrors,
} from '../pure-utils';

const SLN_SAMPLE = `Microsoft Visual Studio Solution File, Format Version 12.00
# Visual Studio Version 17
VisualStudioVersion = 17.0.31903.59
MinimumVisualStudioVersion = 10.0.40219.1
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "MyApp", "src\\MyApp\\MyApp.csproj", "{11111111-1111-1111-1111-111111111111}"
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "MyApp.Core", "src\\MyApp.Core\\MyApp.Core.csproj", "{22222222-2222-2222-2222-222222222222}"
EndProject
Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "solution-items", "solution-items", "{33333333-3333-3333-3333-333333333333}"
EndProject
Global
	GlobalSection(SolutionConfigurationPlatforms) = preSolution
		Debug|Any CPU = Debug|Any CPU
	EndGlobalSection
EndGlobal
`;

const SLNX_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<Solution>
  <Project Path="src\\App\\App.csproj" />
  <Folder Name="/solution-items">
    <Project Path="README.md" />
  </Folder>
  <Project Path="tests\\App.Tests\\App.Tests.csproj" />
</Solution>
`;

const CSPROJ_CONSOLE = `<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
    <PackageReference Include="Serilog" />
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="..\\Lib\\Lib.csproj" />
  </ItemGroup>

</Project>
`;

const CSPROJ_WEB_MULTI_TFM = `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFrameworks>net6.0;net8.0</TargetFrameworks>
    <IsPackable>false</IsPackable>
    <UserSecretsId>abc-123</UserSecretsId>
    <AssemblyName>Custom.Name</AssemblyName>
    <RootNamespace>Custom.Ns</RootNamespace>
  </PropertyGroup>
</Project>
`;

const CSPROJ_TEST = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.9.0" />
    <PackageReference Include="xunit" Version="2.7.0" />
  </ItemGroup>
</Project>
`;

const CSPROJ_LEGACY = `<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <TargetFrameworkVersion>v4.7.2</TargetFrameworkVersion>
  </PropertyGroup>
</Project>
`;

const LAUNCH_SETTINGS = {
  profiles: {
    'http': {
      commandName: 'Project',
      dotnetRunMessages: true,
      launchBrowser: false,
      applicationUrl: 'http://localhost:5231;https://localhost:7231',
      environmentVariables: { ASPNETCORE_ENVIRONMENT: 'Development' },
    },
    'IIS Express': {
      commandName: 'IISExpress',
      launchUrl: 'weatherforecast',
      environmentVariables: {},
    },
  },
};

const MSBUILD_OUTPUT = [
  'MSBuild version 17.9.8 for .NET',
  '  Determining projects to restore...',
  '  Restored /src/App/App.csproj (in 1.2 sec).',
  '  Program.cs(10,5): error CS0103: The name \'x\' does not exist in the current context [C:\\src\\App\\App.csproj]',
  '  Services\\Foo.cs(3,1): warning CS0219: The variable \'y\' is assigned but never used [C:\\src\\App\\App.csproj]',
  '  Bar.cs(12): error CS1002: ; expected [C:\\src\\Lib\\Lib.csproj]',
  'error NETSDK1004: Assets file not found. Run a dotnet restore.',
  'Build failed.',
].join('\n');

const SDK_LIST_OUTPUT = [
  '7.0.404 [C:\\Program Files\\dotnet\\sdk]',
  '8.0.100 [C:\\Program Files\\dotnet\\sdk]',
  '9.0.100-preview.7.24407.12 [C:\\Program Files\\dotnet\\sdk]',
].join('\n');

const RUNTIME_LIST_OUTPUT = [
  'Microsoft.AspNetCore.App 6.0.25 [C:\\Program Files\\dotnet\\shared\\Microsoft.AspNetCore.App]',
  'Microsoft.AspNetCore.App 8.0.0 [C:\\Program Files\\dotnet\\shared\\Microsoft.AspNetCore.App]',
  'Microsoft.NETCore.App 8.0.0 [C:\\Program Files\\dotnet\\shared\\Microsoft.NETCore.App]',
].join('\n');

const NEW_LIST_JSON = {
  templates: [
    { name: 'Console App', shortName: 'console', type: 'project', languages: ['C#', 'F#'], tags: 'Common/Console' },
    { name: 'ASP.NET Core Web API', shortName: 'webapi', type: 'project', languages: ['C#', 'F#'], tags: 'Web/Web API' },
    { name: 'xUnit Test Project', shortName: 'xunit', type: 'project', languages: ['C#', 'F#', 'VB'], tags: 'Test/xUnit' },
    { name: 'NuGet Config', shortName: 'nugetconfig', type: 'item', languages: [], tags: 'Config' },
    { name: 'EditorConfig file', shortName: 'editorconfig', type: 'item', languages: [], tags: 'Config' },
  ],
};

const NEW_LIST_TEXT = [
  'Templates                                              Short Name   Language   Tags',
  '-----------------------------------------------------  ----------   --------   -------',
  'Console App                                            console      [C#],F#    Common/Console',
  'Class Library                                          classlib     [C#],F#    Common/Library',
  'NuGet Config                                           nugetconfig             Config',
  '',
  'Examples',
].join('\n');

const PACKAGE_SEARCH_JSON = {
  searchResult: [
    {
      sourceName: 'nuget.org',
      packages: [
        { id: 'Newtonsoft.Json', latestVersion: '13.0.3' },
        { id: 'Serilog', latestVersion: '3.1.1' },
      ],
    },
    {
      sourceName: 'private',
      packages: [{ id: 'Serilog', latestVersion: '4.0.0-private' }],
    },
  ],
};

const OUTDATED_JSON = {
  projects: [
    {
      path: path.join(path.sep === '\\' ? 'C:\\src' : '/src', 'App', 'App.csproj'),
      frameworks: [
        {
          framework: 'net8.0',
          topLevelPackages: [
            { id: 'Newtonsoft.Json', resolvedVersion: '12.0.1', requestedVersion: '12.0.1', latestVersion: '13.0.3' },
            { id: 'UpToDate', resolvedVersion: '1.0.0', requestedVersion: '1.0.0', latestVersion: '1.0.0' },
            { id: 'NotRestored', requestedVersion: '2.0.0', latestVersion: '3.0.0' },
          ],
        },
      ],
    },
    {
      path: path.join(path.sep === '\\' ? 'C:\\src' : '/src', 'Lib', 'Lib.csproj'),
      frameworks: [
        {
          framework: 'net8.0',
          topLevelPackages: [{ id: 'UpToDate', resolvedVersion: '1.0.0', latestVersion: '1.0.0' }],
        },
      ],
    },
  ],
};

const NUGET_SOURCES_OUTPUT = [
  'Registered Sources:',
  '  1.  nuget.org https://api.nuget.org/v3/index.json [Enabled]',
  '  2.  my-feed https://pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/index.json [Enabled]',
  '  3.  local-cache C:\\packages [Disabled]',
].join('\n');

describe('shell helpers', () => {
  it('quotes paths containing spaces', () => {
    assert.strictEqual(quoteShellPath('C:\\My Projects\\x'), '"C:\\My Projects\\x"');
    assert.strictEqual(quoteShellPath('C:\\Projects\\x'), 'C:\\Projects\\x');
  });

  it('escapes embedded quotes', () => {
    assert.strictEqual(escapeShellArg('a "b" c'), '"a \\"b\\" c"');
  });

  it('builds terminal commands with quoted args only when needed', () => {
    assert.strictEqual(buildTerminalCommand(['dotnet', 'build', 'C:\\a b\\c.csproj']), 'dotnet build "C:\\a b\\c.csproj"');
    assert.strictEqual(buildTerminalCommand(['dotnet', '--version']), 'dotnet --version');
  });

  it('normalizePathKey lowercases only on Windows', () => {
    if (process.platform === 'win32') {
      assert.strictEqual(normalizePathKey('C:\\A\\B'), 'c:\\a\\b');
    } else {
      assert.strictEqual(normalizePathKey('/A/B'), '/A/B');
    }
  });
});

describe('extractJsonObject', () => {
  it('extracts a balanced object from noisy output', () => {
    assert.strictEqual(extractJsonObject('noise {"a":{"b":1}} trailing'), '{"a":{"b":1}}');
  });

  it('handles braces inside strings', () => {
    assert.strictEqual(extractJsonObject('log {"msg":"has } brace"} end'), '{"msg":"has } brace"}');
  });

  it('returns null when no object present', () => {
    assert.strictEqual(extractJsonObject('no json here'), null);
  });

  it('returns null for unbalanced input', () => {
    assert.strictEqual(extractJsonObject('{"a": 1'), null);
  });
});

describe('parseSln', () => {
  const projects = parseSln(SLN_SAMPLE)!;

  it('parses all project entries', () => {
    assert.strictEqual(projects.length, 3);
  });

  it('parses names and paths', () => {
    assert.strictEqual(projects[0].name, 'MyApp');
    assert.strictEqual(projects[0].relativePath, ['src', 'MyApp', 'MyApp.csproj'].join(path.sep));
    assert.strictEqual(projects[1].name, 'MyApp.Core');
  });

  it('detects solution folders', () => {
    assert.strictEqual(projects[2].isSolutionFolder, true);
    assert.strictEqual(projects[0].isSolutionFolder, false);
    assert.strictEqual(projects[1].isSolutionFolder, false);
  });

  it('uppercases GUIDs', () => {
    assert.strictEqual(projects[0].projectGuid, '11111111-1111-1111-1111-111111111111');
    assert.strictEqual(projects[2].typeGuid, '2150E333-8FDC-42A3-9474-1A3956D46DE8');
  });

  it('returns null for non-sln content', () => {
    assert.strictEqual(parseSln('just some text'), null);
  });
});

describe('parseSlnx', () => {
  it('parses project paths', () => {
    const paths = parseSlnx(SLNX_SAMPLE)!;
    assert.strictEqual(paths.length, 3);
    assert.ok(paths.includes(['src', 'App', 'App.csproj'].join(path.sep)));
    assert.ok(paths.includes('README.md'));
  });

  it('returns null for non-slnx content', () => {
    assert.strictEqual(parseSlnx('<other></other>'), null);
  });
});

describe('parseCsproj', () => {
  it('parses an SDK-style console project', () => {
    const info = parseCsproj(CSPROJ_CONSOLE)!;
    assert.strictEqual(info.sdk, 'Microsoft.NET.Sdk');
    assert.strictEqual(info.sdkStyle, true);
    assert.strictEqual(info.isWeb, false);
    assert.strictEqual(info.outputType, 'Exe');
    assert.deepStrictEqual(info.targetFrameworks, ['net8.0']);
    assert.strictEqual(info.isPackable, true);
    assert.strictEqual(info.isTestProject, false);
    assert.strictEqual(info.packageReferences.length, 2);
    assert.deepStrictEqual(info.packageReferences[0], { id: 'Newtonsoft.Json', version: '13.0.3' });
    assert.strictEqual(info.packageReferences[1].version, undefined);
    assert.deepStrictEqual(info.projectReferences, [['..', 'Lib', 'Lib.csproj'].join(path.sep)]);
    assert.ok(isRunnableProject(info));
  });

  it('parses a multi-target web project', () => {
    const info = parseCsproj(CSPROJ_WEB_MULTI_TFM)!;
    assert.strictEqual(info.isWeb, true);
    assert.deepStrictEqual(info.targetFrameworks, ['net6.0', 'net8.0']);
    assert.strictEqual(info.isPackable, false);
    assert.strictEqual(info.userSecretsId, 'abc-123');
    assert.strictEqual(info.assemblyName, 'Custom.Name');
    assert.strictEqual(info.rootNamespace, 'Custom.Ns');
    assert.strictEqual(info.outputType, 'Library');
    assert.ok(isRunnableProject(info));
  });

  it('detects test projects', () => {
    const info = parseCsproj(CSPROJ_TEST)!;
    assert.strictEqual(info.isTestProject, true);
    assert.ok(!isRunnableProject(info));
  });

  it('returns null for legacy non-SDK projects', () => {
    assert.strictEqual(parseCsproj(CSPROJ_LEGACY), null);
  });

  it('defaults outputType to Library', () => {
    const info = parseCsproj('<Project Sdk="Microsoft.NET.Sdk"></Project>')!;
    assert.strictEqual(info.outputType, 'Library');
  });
});

describe('buildProgramPath', () => {
  it('builds the default output path', () => {
    const dir = path.join(path.sep === '\\' ? 'C:\\src' : '/src', 'App');
    assert.strictEqual(
      buildProgramPath(dir, 'net8.0', undefined, 'App'),
      path.join(dir, 'bin', 'Debug', 'net8.0', 'App.dll'),
    );
  });

  it('uses AssemblyName and configuration', () => {
    const dir = path.join(path.sep === '\\' ? 'C:\\src' : '/src', 'App');
    assert.strictEqual(
      buildProgramPath(dir, 'net6.0', 'Custom.Name', 'App', 'Release'),
      path.join(dir, 'bin', 'Release', 'net6.0', 'Custom.Name.dll'),
    );
  });
});

describe('parseLaunchSettingsProfiles', () => {
  const profiles = parseLaunchSettingsProfiles(LAUNCH_SETTINGS);

  it('parses all profiles', () => {
    assert.strictEqual(profiles.length, 2);
  });

  it('parses applicationUrl and env', () => {
    const http = profiles.find((p) => p.name === 'http')!;
    assert.strictEqual(http.commandName, 'Project');
    assert.strictEqual(http.applicationUrl, 'http://localhost:5231;https://localhost:7231');
    assert.strictEqual(http.environmentVariables?.ASPNETCORE_ENVIRONMENT, 'Development');
  });

  it('handles empty env objects', () => {
    const iis = profiles.find((p) => p.name === 'IIS Express')!;
    assert.strictEqual(iis.commandName, 'IISExpress');
    assert.deepStrictEqual(iis.environmentVariables, {});
  });

  it('falls back to ASPNETCORE_URLS from environment variables', () => {
    const profiles = parseLaunchSettingsProfiles({
      profiles: { p: { commandName: 'Project', environmentVariables: { ASPNETCORE_URLS: 'http://localhost:9999' } } },
    });
    assert.strictEqual(profiles[0].applicationUrl, 'http://localhost:9999');
  });

  it('returns empty for invalid input', () => {
    assert.deepStrictEqual(parseLaunchSettingsProfiles(null), []);
    assert.deepStrictEqual(parseLaunchSettingsProfiles({}), []);
  });
});

describe('parseMsbuildIssues', () => {
  const issues = parseMsbuildIssues(MSBUILD_OUTPUT);

  it('parses errors and warnings with file locations', () => {
    assert.strictEqual(issues.length, 4);
    const cs0103 = issues[0];
    assert.strictEqual(cs0103.file, 'Program.cs');
    assert.strictEqual(cs0103.line, 10);
    assert.strictEqual(cs0103.column, 5);
    assert.strictEqual(cs0103.severity, 'error');
    assert.strictEqual(cs0103.code, 'CS0103');
    assert.ok(cs0103.message.includes('does not exist'));
    assert.strictEqual(cs0103.project, 'C:\\src\\App\\App.csproj');
  });

  it('parses warnings', () => {
    const warning = issues[1];
    assert.strictEqual(warning.severity, 'warning');
    assert.strictEqual(warning.code, 'CS0219');
    assert.strictEqual(warning.file, ['Services', 'Foo.cs'].join(path.sep) === 'Services\\Foo.cs' ? 'Services\\Foo.cs' : 'Services/Foo.cs');
  });

  it('parses locations without a column', () => {
    const cs1002 = issues[2];
    assert.strictEqual(cs1002.line, 12);
    assert.strictEqual(cs1002.column, undefined);
    assert.strictEqual(cs1002.project, 'C:\\src\\Lib\\Lib.csproj');
  });

  it('parses bare errors without a file', () => {
    const bare = issues[3];
    assert.strictEqual(bare.file, undefined);
    assert.strictEqual(bare.code, 'NETSDK1004');
  });

  it('counts errors', () => {
    assert.strictEqual(countErrors(issues), 3);
  });

  it('ignores non-issue lines', () => {
    assert.deepStrictEqual(parseMsbuildIssues('Build succeeded.\n  0 Warning(s)\n  0 Error(s)'), []);
  });
});

describe('parseSdkList / parseRuntimeList', () => {
  it('parses SDK versions with paths', () => {
    const sdks = parseSdkList(SDK_LIST_OUTPUT);
    assert.strictEqual(sdks.length, 3);
    assert.strictEqual(sdks[0].version, '7.0.404');
    assert.strictEqual(sdks[1].path, 'C:\\Program Files\\dotnet\\sdk');
    assert.strictEqual(sdks[2].version, '9.0.100-preview.7.24407.12');
  });

  it('parses runtimes', () => {
    const runtimes = parseRuntimeList(RUNTIME_LIST_OUTPUT);
    assert.strictEqual(runtimes.length, 3);
    assert.strictEqual(runtimes[0].name, 'Microsoft.AspNetCore.App');
    assert.strictEqual(runtimes[0].version, '6.0.25');
    assert.strictEqual(runtimes[2].name, 'Microsoft.NETCore.App');
  });
});

describe('dotnet new parsing', () => {
  it('parses JSON template lists', () => {
    const templates = parseNewListJson(NEW_LIST_JSON);
    assert.strictEqual(templates.length, 5);
    const console = templates.find((t) => t.shortName === 'console')!;
    assert.strictEqual(console.name, 'Console App');
    assert.strictEqual(console.type, 'project');
    assert.deepStrictEqual(console.languages, ['C#', 'F#']);
    assert.strictEqual(console.category, 'Common');
    assert.strictEqual(templates.find((t) => t.shortName === 'webapi')!.category, 'Web');
    assert.strictEqual(templates.find((t) => t.shortName === 'xunit')!.category, 'Test');
    assert.strictEqual(templates.find((t) => t.shortName === 'nugetconfig')!.category, 'Files');
  });

  it('parses text template lists as fallback', () => {
    const templates = parseNewListText(NEW_LIST_TEXT);
    const console = templates.find((t) => t.shortName === 'console');
    assert.ok(console);
    assert.strictEqual(console.name, 'Console App');
    const classlib = templates.find((t) => t.shortName === 'classlib');
    assert.ok(classlib);
    const nugetconfig = templates.find((t) => t.shortName === 'nugetconfig');
    assert.ok(nugetconfig);
    assert.strictEqual(nugetconfig.tags, 'Config');
    assert.strictEqual(templates.find((t) => t.shortName === 'Examples'), undefined);
  });

  it('categorizes known and unknown short names', () => {
    assert.strictEqual(categorizeTemplate('console', ''), 'Common');
    assert.strictEqual(categorizeTemplate('worker', ''), 'Services');
    assert.strictEqual(categorizeTemplate('something-new', 'Blah/Thing'), 'Blah');
    assert.strictEqual(categorizeTemplate('something-new', ''), 'Other');
  });

  it('handles empty JSON input', () => {
    assert.deepStrictEqual(parseNewListJson({}), []);
    assert.deepStrictEqual(parseNewListJson({ templates: 'nope' }), []);
  });
});

describe('NuGet parsing', () => {
  it('parses package search results across sources', () => {
    const results = parsePackageSearchJson(PACKAGE_SEARCH_JSON);
    assert.strictEqual(results.length, 3);
    assert.strictEqual(results[0].id, 'Newtonsoft.Json');
    assert.strictEqual(results[0].latestVersion, '13.0.3');
    assert.strictEqual(results[0].source, 'nuget.org');
    assert.strictEqual(results[2].source, 'private');
  });

  it('parses outdated package lists and filters up-to-date entries', () => {
    const projects = parsePackageListOutdatedJson(OUTDATED_JSON);
    assert.strictEqual(projects.length, 1);
    const project = projects[0];
    assert.strictEqual(project.project, 'App.csproj');
    assert.strictEqual(project.packages.length, 2);
    assert.deepStrictEqual(project.packages[0], { id: 'Newtonsoft.Json', current: '12.0.1', latest: '13.0.3' });
    assert.strictEqual(project.packages[1].current, '2.0.0');
  });

  it('parses nuget source lists', () => {
    const sources = parseNuGetSourcesList(NUGET_SOURCES_OUTPUT);
    assert.strictEqual(sources.length, 3);
    assert.strictEqual(sources[0].name, 'nuget.org');
    assert.ok(sources[0].enabled);
    assert.strictEqual(sources[2].name, 'local-cache');
    assert.ok(!sources[2].enabled);
  });

  it('handles empty/invalid search JSON', () => {
    assert.deepStrictEqual(parsePackageSearchJson({}), []);
    assert.deepStrictEqual(parsePackageListOutdatedJson(null), []);
  });
});

describe('findBestProjectForPath', () => {
  const root = path.sep === '\\' ? 'C:\\repo' : '/repo';
  const projects = [
    { name: 'root', csprojPath: path.join(root, 'Root.csproj') },
    { name: 'nested', csprojPath: path.join(root, 'nested', 'Nested.csproj') },
    { name: 'other', csprojPath: path.join(root, 'other', 'Other.csproj') },
  ];

  it('prefers the most specific project', () => {
    const file = path.join(root, 'nested', 'deep', 'File.cs');
    assert.strictEqual(findBestProjectForPath(file, projects), 'nested');
  });

  it('matches files at the root', () => {
    const file = path.join(root, 'Program.cs');
    assert.strictEqual(findBestProjectForPath(file, projects), 'root');
  });

  it('returns null for files outside all projects', () => {
    const outside = path.join(path.sep === '\\' ? 'C:\\elsewhere' : '/elsewhere', 'File.cs');
    assert.strictEqual(findBestProjectForPath(outside, projects), null);
  });

  it('is case-insensitive on Windows', () => {
    const file = path.join(root, 'NESTED', 'File.cs');
    if (process.platform === 'win32') {
      assert.strictEqual(findBestProjectForPath(file, projects), 'nested');
    }
  });
});

describe('validators', () => {
  it('validates project names', () => {
    assert.strictEqual(validateProjectName('My.App-2_x'), null);
    assert.notStrictEqual(validateProjectName(''), null);
    assert.notStrictEqual(validateProjectName('a/b'), null);
    assert.notStrictEqual(validateProjectName('..'), null);
  });

  it('validates package ids', () => {
    assert.strictEqual(validatePackageId('Newtonsoft.Json'), null);
    assert.notStrictEqual(validatePackageId('bad id'), null);
    assert.notStrictEqual(validatePackageId('$(rm)'), null);
  });

  it('validates test filters', () => {
    assert.strictEqual(validateTestFilter('FullyQualifiedName~MyTests'), null);
    assert.strictEqual(validateTestFilter('FullyQualifiedName~A|Category=fast'), null);
    assert.notStrictEqual(validateTestFilter('has "quotes"'), null);
    assert.notStrictEqual(validateTestFilter('has `tick`'), null);
    assert.notStrictEqual(validateTestFilter('   '), null);
  });

  it('validates custom commands', () => {
    assert.strictEqual(validateCustomCommand('dotnet build -c Release'), null);
    assert.notStrictEqual(validateCustomCommand(''), null);
    assert.notStrictEqual(validateCustomCommand('rm -rf /'), null);
    assert.notStrictEqual(validateCustomCommand('dotnet build && echo pwned'), null);
    assert.notStrictEqual(validateCustomCommand('echo $(whoami)'), null);
    assert.notStrictEqual(validateCustomCommand('echo `whoami`'), null);
    assert.notStrictEqual(validateCustomCommand('dotnet build > out.txt'), null);
  });

  it('validates nuget source names', () => {
    assert.strictEqual(validateNuGetSourceName('my-feed'), null);
    assert.notStrictEqual(validateNuGetSourceName('has space'), null);
    assert.notStrictEqual(validateNuGetSourceName(''), null);
  });
});

describe('companion file candidates', () => {
  it('maps razor to its code-behind and css', () => {
    assert.deepStrictEqual(markupCompanionCandidates('Foo.razor'), ['Foo.razor.cs', 'Foo.razor.css']);
  });

  it('maps razor code-behind back to markup', () => {
    assert.deepStrictEqual(markupCompanionCandidates('Foo.razor.cs'), ['Foo.razor', 'Foo.razor.css']);
  });

  it('maps xaml and cshtml', () => {
    assert.deepStrictEqual(markupCompanionCandidates('Main.xaml'), ['Main.xaml.cs']);
    assert.deepStrictEqual(markupCompanionCandidates('Main.xaml.cs'), ['Main.xaml']);
    assert.deepStrictEqual(markupCompanionCandidates('Page.cshtml'), ['Page.cshtml.cs']);
    assert.deepStrictEqual(markupCompanionCandidates('Page.cshtml.cs'), ['Page.cshtml']);
  });

  it('returns nothing for plain cs files', () => {
    assert.deepStrictEqual(markupCompanionCandidates('Foo.cs'), []);
  });

  it('computes test file candidates', () => {
    assert.deepStrictEqual(testFileCandidates('Foo.cs'), ['FooTests.cs', 'FooTest.cs', 'FooFacts.cs']);
    assert.deepStrictEqual(testFileCandidates('Foo.razor.cs'), []);
    assert.deepStrictEqual(testFileCandidates('App.xaml'), []);
  });

  it('derives the source base for test files', () => {
    assert.strictEqual(sourceBaseForTestFile('FooTests.cs'), 'Foo');
    assert.strictEqual(sourceBaseForTestFile('FooTest.cs'), 'Foo');
    assert.strictEqual(sourceBaseForTestFile('FooFacts.cs'), 'Foo');
    assert.strictEqual(sourceBaseForTestFile('Foo.cs'), null);
  });

  it('detects code-behind files', () => {
    assert.ok(isCodeBehindFile('Foo.razor.cs'));
    assert.ok(isCodeBehindFile('Foo.xaml.cs'));
    assert.ok(isCodeBehindFile('Foo.cshtml.cs'));
    assert.ok(!isCodeBehindFile('Foo.cs'));
  });
});

describe('configuration helpers', () => {
  it('maps settings to -c flags', () => {
    assert.deepStrictEqual(configFlag('default'), []);
    assert.deepStrictEqual(configFlag('debug'), ['-c', 'Debug']);
    assert.deepStrictEqual(configFlag('release'), ['-c', 'Release']);
    assert.deepStrictEqual(configFlag(undefined), []);
  });

  it('labels configurations', () => {
    assert.strictEqual(configurationLabel('debug'), 'Debug');
    assert.strictEqual(configurationLabel('release'), 'Release');
    assert.strictEqual(configurationLabel(undefined), 'Default');
  });
});
