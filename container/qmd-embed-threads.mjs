// Caps the CPU threads qmd uses to embed, for runs on pyrybox.
//
// Loaded with `node --import` through NODE_OPTIONS by pyrycode-qmd-refresh.sh
// and the entrypoint's first index build. qmd 2.1.0 has no setting for this:
// on a machine without a GPU it gives its one embedding context every math
// core the CPU reports, which is all four cores of pyrybox's i7-3770, and two
// agent pipelines' test gates share those cores.
//
// qmd creates that context through node-llama-cpp's
// LlamaModel.createEmbeddingContext, so this wraps that method and lowers the
// `threads` option to QMD_EMBED_THREADS (default 2). The module is resolved
// from qmd's own install, so the class patched is the one qmd uses.
//
// If anything here fails, qmd still runs, with all its threads, and a line on
// stderr says so.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const QMD_CLI = "/usr/local/lib/node_modules/@tobilu/qmd/dist/cli/qmd.js";

const cap = Number.parseInt(process.env.QMD_EMBED_THREADS ?? "2", 10);

try {
  if (!Number.isInteger(cap) || cap < 1) throw new Error(`QMD_EMBED_THREADS must be a whole number of at least 1, got "${process.env.QMD_EMBED_THREADS}"`);
  const cli = process.argv[1]?.includes("/@tobilu/qmd/") ? process.argv[1] : QMD_CLI;
  const entry = createRequire(cli).resolve("node-llama-cpp");
  const { LlamaModel } = await import(pathToFileURL(entry).href);
  const createEmbeddingContext = LlamaModel.prototype.createEmbeddingContext;
  if (typeof createEmbeddingContext !== "function") throw new Error("LlamaModel.createEmbeddingContext not found");
  LlamaModel.prototype.createEmbeddingContext = function (options = {}) {
    const threads = typeof options.threads === "number" ? Math.min(options.threads, cap) : cap;
    return createEmbeddingContext.call(this, { ...options, threads });
  };
} catch (err) {
  process.stderr.write(`qmd-embed-threads: thread cap not applied: ${err?.message ?? err}\n`);
}
