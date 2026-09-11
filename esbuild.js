const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      });
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  const graphCtx = await esbuild.context({
    entryPoints: ['src/nuget-graph-webview.ts', 'src/nuget-graph-webview.css', 'src/security-webview.ts', 'src/security-webview.css'],
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022',
    minify: production, sourcemap: !production, outdir: 'dist',
  });
  require('fs').mkdirSync('dist', { recursive: true });
  require('fs').copyFileSync('node_modules/cytoscape/LICENSE', 'dist/cytoscape-LICENSE.txt');
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    alias: {
      'jsonc-parser': require('path').join(__dirname, 'node_modules', 'jsonc-parser', 'lib', 'esm', 'main.js'),
    },
    logLevel: 'silent',
    plugins: [esbuildProblemMatcherPlugin],
  });
  if (watch) {
    await graphCtx.watch();
    await ctx.watch();
  } else {
    await graphCtx.rebuild();
    await graphCtx.dispose();
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
