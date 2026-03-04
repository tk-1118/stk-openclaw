#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.join(rootDir, "apps", "electron", ".runtime");
const runtimeOpenClawDir = path.join(runtimeRoot, "openclaw");

const platform = process.platform;
const arch = process.arch;
const platformKey = `${platform}-${arch}`;
const nodeBinaryName = platform === "win32" ? "node.exe" : "node";
const nodeTargetDir = path.join(runtimeRoot, "node", platformKey);
const nodeSourcePath = process.execPath;
const nodeTargetPath = path.join(nodeTargetDir, nodeBinaryName);

async function ensureFreshDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

async function copyFileSafe(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

async function copyDirSafe(source, target) {
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(source, target, { recursive: true, force: true });
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await ensureFreshDir(runtimeRoot);
  await fs.mkdir(nodeTargetDir, { recursive: true });

  const requiredPaths = [
    "openclaw.mjs",
    "package.json",
    "dist",
    "node_modules",
  ];

  for (const rel of requiredPaths) {
    const absolutePath = path.join(rootDir, rel);
    if (!(await pathExists(absolutePath))) {
      throw new Error(`Missing runtime prerequisite: ${absolutePath}`);
    }
  }

  await copyFileSafe(nodeSourcePath, nodeTargetPath);
  if (platform !== "win32") {
    await fs.chmod(nodeTargetPath, 0o755);
  }

  await fs.mkdir(runtimeOpenClawDir, { recursive: true });
  await copyFileSafe(path.join(rootDir, "openclaw.mjs"), path.join(runtimeOpenClawDir, "openclaw.mjs"));
  await copyFileSafe(path.join(rootDir, "package.json"), path.join(runtimeOpenClawDir, "package.json"));
  await copyDirSafe(path.join(rootDir, "dist"), path.join(runtimeOpenClawDir, "dist"));
  await copyDirSafe(path.join(rootDir, "node_modules"), path.join(runtimeOpenClawDir, "node_modules"));

  await fs.writeFile(
    path.join(runtimeRoot, "runtime-metadata.json"),
    JSON.stringify(
      {
        preparedAt: new Date().toISOString(),
        platform,
        arch,
        platformKey,
        nodeBinaryName,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`Prepared Electron runtime in ${runtimeRoot}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
