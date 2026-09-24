#!/usr/bin/env node
// Thin launcher: run the Python `clearcote-mcp` stdio server, installing it on first use.
// The Python package pulls in `clearcote` (which downloads + SHA-256-verifies the stealth binary).
"use strict";
const { spawnSync, spawn } = require("node:child_process");
const { version: LAUNCHER_VERSION } = require("./package.json");

function pythons() {
  return process.platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"];
}
function findPython() {
  for (const p of pythons()) {
    const r = spawnSync(p, ["-c", "import sys;print(sys.version_info[0])"], { encoding: "utf8" });
    if (r.status === 0 && (r.stdout || "").trim() === "3") return p;
  }
  return null;
}
// Version of the importable Python server, or null when it is missing or fails to import (0.1.0
// fails under mcp 2.x, and a plain `pip install` would call it satisfied and leave it broken).
function serverVersion(py) {
  const r = spawnSync(py, ["-c", "import clearcote_mcp;print(clearcote_mcp.__version__)"],
                      { encoding: "utf8" });
  return r.status === 0 ? (r.stdout || "").trim() : null;
}
function older(a, b) {
  const num = (v) => v.split(".").map((p) => parseInt(p, 10) || 0);
  const pa = num(a), pb = num(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

const py = findPython();
if (!py) {
  console.error("[clearcote-mcp] Python 3.10+ is required (not found). Install Python, then re-run.");
  process.exit(1);
}
const have = serverVersion(py);
if (!have || older(have, LAUNCHER_VERSION)) {
  const spec = "clearcote-mcp>=" + LAUNCHER_VERSION;
  console.error(have
    ? `[clearcote-mcp] upgrading the Python package \`clearcote-mcp\` ${have} -> ${LAUNCHER_VERSION}…`
    : "[clearcote-mcp] installing the Python package `clearcote-mcp`…");
  // pip's stdout goes to stderr: stdout is the MCP channel the client is about to read.
  const install = spawnSync(py, ["-m", "pip", "install", "--user", "--quiet", "--upgrade", spec],
                            { stdio: ["ignore", 2, 2] });
  const now = serverVersion(py);
  if (install.status !== 0 || !now || older(now, LAUNCHER_VERSION)) {
    console.error(`[clearcote-mcp] install failed. Run:  ${py} -m pip install --upgrade "${spec}"`);
    process.exit(1);
  }
}
// Hand over stdio to the MCP server (stdio transport).
const child = spawn(py, ["-m", "clearcote_mcp"], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code == null ? 0 : code));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
