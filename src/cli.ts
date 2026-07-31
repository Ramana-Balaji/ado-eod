#!/usr/bin/env node
// ado-eod — `setup` wires your IDEs; `serve` (default) runs the MCP server.
const cmd = process.argv[2] ?? "serve";

if (cmd === "setup") {
  const { setup } = await import("./setup.js");
  await setup(process.argv.slice(3));
} else if (cmd === "serve") {
  const { main } = await import("./index.js");
  await main();
} else {
  console.error(`ado-eod: unknown command "${cmd}". Use: ado-eod setup | ado-eod serve`);
  process.exit(1);
}
