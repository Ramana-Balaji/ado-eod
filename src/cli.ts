#!/usr/bin/env node
// ado-eod — `setup` wires your IDEs; `serve` (default) runs the MCP server.

// npm only WARNS on an engines mismatch, so an old Node installs everything and
// then fails somewhere deep in @azure/* with a message that never mentions Node.
// Say it here, once, in the one place both commands pass through.
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(
    `ado-eod needs Node 20 or newer (Node 22 LTS recommended) — this is Node ${process.versions.node}, which reached end of life in April 2025.\n` +
      `  nvm:   nvm install 22 && nvm use 22\n` +
      `  Ubuntu/WSL: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs\n` +
      `Then re-run this command.`,
  );
  process.exit(1);
}

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
