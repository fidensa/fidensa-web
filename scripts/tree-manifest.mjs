import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? process.cwd());
const exclusions = [
  { path: ".git/", reason: "VCS metadata; not product content" },
  {
    path: ".claude/.cc-writes/",
    reason: "named host tool-state directory; not product content",
  },
  { path: ".next/", reason: "disposable Next.js build output" },
  { path: "node_modules/", reason: "disposable installed dependency output" },
  { path: ".npm-cache/", reason: "disposable package-manager cache output" },
  { path: "coverage/", reason: "disposable test coverage output" },
  { path: "test-results/", reason: "disposable test result output" },
  { path: "out/", reason: "disposable static build output" },
  { path: "*.tsbuildinfo", reason: "disposable TypeScript incremental output" },
];

function excluded(relative, directory) {
  const normalized =
    relative.split(path.sep).join("/") + (directory ? "/" : "");
  return exclusions.some((item) => {
    if (item.path === "*.tsbuildinfo")
      return normalized.endsWith(".tsbuildinfo");
    return normalized === item.path || normalized.startsWith(item.path);
  });
}

async function walk(directory, relative = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const nextRelative = path.join(relative, entry.name);
    if (excluded(nextRelative, entry.isDirectory())) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`Manifest refuses symbolic link: ${nextRelative}`);
    }
    if (entry.isDirectory())
      result.push(
        ...(await walk(path.join(directory, entry.name), nextRelative)),
      );
    else if (entry.isFile()) result.push(nextRelative);
  }
  return result;
}

const files = [];
for (const relative of await walk(root)) {
  const absolute = path.join(root, relative);
  const content = await readFile(absolute);
  const metadata = await stat(absolute);
  files.push({
    path: relative.split(path.sep).join("/"),
    bytes: content.byteLength,
    mode: (metadata.mode & 0o777).toString(8).padStart(3, "0"),
    sha256: createHash("sha256").update(content).digest("hex"),
  });
}

const treeHash = createHash("sha256")
  .update(files.map((file) => `${file.sha256}  ${file.path}\n`).join(""))
  .digest("hex");

process.stdout.write(
  `${JSON.stringify(
    {
      manifestVersion: 1,
      algorithm: "sha256",
      root: "web",
      treeHash,
      exclusions,
      files,
    },
    null,
    2,
  )}\n`,
);
