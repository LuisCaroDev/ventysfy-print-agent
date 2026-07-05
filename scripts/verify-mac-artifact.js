#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");

function run(command, args) {
  try {
    const output = execFileSync(command, args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { ok: true, output };
  } catch (error) {
    return {
      ok: false,
      output: `${error.stdout || ""}${error.stderr || ""}`.trim(),
    };
  }
}

const dmgFiles = fs
  .readdirSync(distDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".dmg"))
  .map((entry) => path.join(distDir, entry.name))
  .sort();

if (dmgFiles.length === 0) {
  console.error("No .dmg artifact found in dist/");
  process.exit(1);
}

const dmgPath = dmgFiles[dmgFiles.length - 1];
console.log(`Artifact: ${path.relative(projectRoot, dmgPath)}`);

const spctlResult = run("spctl", ["-a", "-vv", dmgPath]);
console.log("\n[spctl]");
console.log(spctlResult.output || "(no output)");

const notarizationResult = run("xcrun", ["stapler", "validate", dmgPath]);
console.log("\n[stapler]");
console.log(notarizationResult.output || "(no output)");

if (!spctlResult.ok || !notarizationResult.ok) {
  process.exit(1);
}
