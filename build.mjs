// Bundles the three browser pages into public/build/. Run with --watch while developing.
import * as esbuild from "esbuild";

const opts = {
  entryPoints: ["src/client/board.ts", "src/client/play.ts", "src/client/host.ts", "src/client/lab.ts"],
  outdir: "public/build",
  bundle: true,
  format: "esm",
  splitting: true,
  minify: true,
  sourcemap: true,
  target: "es2022",
  logLevel: "info",
};
if (process.argv.includes("--watch")) (await esbuild.context(opts)).watch();
else await esbuild.build(opts);
