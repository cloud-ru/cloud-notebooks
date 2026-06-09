// Bundles the extension into dist/extension.js for the VS Code extension host.
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  // vscode is provided by the runtime; never bundle it.
  // vscode is provided by the runtime; puppeteer-core is heavy + dynamic, so it is required from
  // node_modules at runtime rather than bundled.
  external: ["vscode", "puppeteer-core"],
  minify: production,
  logLevel: "info",
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("esbuild: watching…");
  } else {
    await esbuild.build(options);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
