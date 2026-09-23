import { execFileSync } from "node:child_process";

import { assertSupportedToolchain } from "./toolchain.mjs";

const npmVersion = execFileSync("npm", ["--version"], {
  encoding: "utf8",
}).trim();

assertSupportedToolchain(process.versions.node, npmVersion);
process.stdout.write(
  `Supported toolchain: Node.js ${process.versions.node}, npm ${npmVersion}\n`,
);
