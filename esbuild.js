const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/**
 * Reports build state on single lines that a plain VS Code problem matcher can
 * read. esbuild's own pretty output spreads one error over several lines with a
 * blank line in the middle, which no inline matcher can follow — that is why
 * the usual advice is to install the esbuild-problem-matchers extension. Doing
 * it here instead keeps F5 working on a clean machine.
 */
const problemMatcherLog = {
  name: 'chronus-log',
  setup(build) {
    build.onStart(() => console.log('[build] started'));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(
          location
            ? `${location.file}:${location.line}:${location.column}: error: ${text}`
            : `error: ${text}`
        );
      }
      for (const { text, location } of result.warnings) {
        console.error(
          location
            ? `${location.file}:${location.line}:${location.column}: warning: ${text}`
            : `warning: ${text}`
        );
      }
      console.log(`[build] finished with ${result.errors.length} error(s)`);
    });
  }
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    logLevel: 'silent',
    plugins: [problemMatcherLog]
  });

  if (watch) {
    await ctx.watch();
    console.log('[chronus] watching...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
