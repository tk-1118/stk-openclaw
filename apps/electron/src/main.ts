import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import JSON5 from "json5";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PORT = 19001;
const HEALTH_PATH = "/healthz";
const GATEWAY_SHUTDOWN_TIMEOUT_MS = 8_000;
const GATEWAY_READY_TIMEOUT_MS = 30_000;
const GATEWAY_READY_POLL_MS = 500;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 5_000;

type GatewayState = "stopped" | "starting" | "ready" | "error";

interface GatewayStatus {
  state: GatewayState;
  port: number | null;
  pid: number | null;
  startedAtMs: number | null;
  lastError: string | null;
}

let mainWindow: BrowserWindow | null = null;
let gatewayProcess: ChildProcessWithoutNullStreams | null = null;
let gatewayStatus: GatewayStatus = {
  state: "stopped",
  port: null,
  pid: null,
  startedAtMs: null,
  lastError: null,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimePlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function isPackagedApp(): boolean {
  return app.isPackaged;
}

function repoRootDir(): string {
  // dist/main.js -> apps/electron/dist/main.js
  return path.resolve(__dirname, "..", "..", "..");
}

function runtimeRootDir(): string {
  if (isPackagedApp()) {
    return path.join(process.resourcesPath, "openclaw-runtime");
  }
  return repoRootDir();
}

function resolveNodeBinary(): string {
  const platformNodeName = process.platform === "win32" ? "node.exe" : "node";
  const platformKey = runtimePlatformKey();
  const packagedCandidates = [path.join(process.resourcesPath, "node-runtime", platformKey, platformNodeName)];
  // Windows packaged apps may run under emulation; try common fallback runtime dirs.
  if (isPackagedApp() && process.platform === "win32") {
    packagedCandidates.push(path.join(process.resourcesPath, "node-runtime", "win32-x64", platformNodeName));
    packagedCandidates.push(path.join(process.resourcesPath, "node-runtime", "win32-arm64", platformNodeName));
  }
  if (isPackagedApp()) {
    const nodeRuntimeRoot = path.join(process.resourcesPath, "node-runtime");
    let availableRuntimeDirs: string[] = [];
    try {
      if (fs.existsSync(nodeRuntimeRoot)) {
        availableRuntimeDirs = fs
          .readdirSync(nodeRuntimeRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .toSorted();
      }
    } catch {
      // ignore directory read errors
    }
    let runtimeMetadata: string | null = null;
    try {
      const metadataPath = path.join(process.resourcesPath, "runtime-metadata.json");
      if (fs.existsSync(metadataPath)) {
        runtimeMetadata = fs.readFileSync(metadataPath, "utf8");
      }
    } catch {
      // ignore metadata read errors
    }
    for (const candidate of packagedCandidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    throw new Error(
      `Bundled Node runtime not found. Expected one of: ${packagedCandidates.join(", ")}. ` +
        `Available runtime dirs: ${availableRuntimeDirs.join(", ") || "<none>"}. ` +
        (runtimeMetadata ? `Runtime metadata: ${runtimeMetadata}` : "Runtime metadata: <missing>."),
    );
  }

  const devCandidate = path.join(repoRootDir(), "apps", "electron", ".runtime", "node", platformKey, platformNodeName);
  if (fs.existsSync(devCandidate)) {
    return devCandidate;
  }

  return "node";
}

function gatewayEntryPath(): string {
  return path.join(runtimeRootDir(), "openclaw.mjs");
}

function resolveGatewayConfigPathCandidates(): string[] {
  const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (configPath) {
    return [path.resolve(configPath)];
  }

  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) {
    return [path.join(path.resolve(stateDir), "openclaw.json")];
  }

  const homeDir = process.env.OPENCLAW_HOME?.trim() || process.env.HOME?.trim() || os.homedir();
  const resolvedHome = path.resolve(homeDir);
  return [
    path.join(resolvedHome, ".openclaw", "openclaw.json"),
    path.join(resolvedHome, ".clawdbot", "openclaw.json"),
    path.join(resolvedHome, ".moldbot", "openclaw.json"),
    path.join(resolvedHome, ".moltbot", "openclaw.json"),
  ];
}

async function resolveGatewayToken(): Promise<string | null> {
  const fromEnv = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  for (const configPath of resolveGatewayConfigPathCandidates()) {
    try {
      if (!fs.existsSync(configPath)) {
        continue;
      }
      const raw = fs.readFileSync(configPath, "utf8");
      if (!raw.trim()) {
        continue;
      }
      const parsed = JSON5.parse(raw);
      const tokenCandidate = parsed?.gateway?.auth?.token;
      if (typeof tokenCandidate === "string" && tokenCandidate.trim()) {
        return tokenCandidate.trim();
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function buildDashboardUrl(port: number): Promise<string> {
  const baseUrl = `http://127.0.0.1:${port}/`;
  const gatewayUrl = `ws://127.0.0.1:${port}/`;
  const token = await resolveGatewayToken();
  const hashParams = new URLSearchParams();
  hashParams.set("gatewayUrl", gatewayUrl);
  if (token) {
    hashParams.set("token", token);
  }
  const fragment = hashParams.toString();
  return fragment ? `${baseUrl}#${fragment}` : baseUrl;
}

function gatewayLogPath(): string {
  return path.join(app.getPath("userData"), "gateway.log");
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function isLocalDashboardURL(input: string): boolean {
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

function nextBackoffMs(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(attempt, 0));
}

async function findAvailablePort(startPort = DEFAULT_PORT): Promise<number> {
  for (let port = startPort; port < startPort + 100; port += 1) {
    const available = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, "127.0.0.1");
    });
    if (available) {
      return port;
    }
  }
  throw new Error(`No available local port found near ${startPort}`);
}

async function waitForGatewayReady(port: number): Promise<void> {
  const deadline = Date.now() + GATEWAY_READY_TIMEOUT_MS;
  const target = `http://127.0.0.1:${port}${HEALTH_PATH}`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(target, { method: "GET" });
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling until timeout
    }
    await sleep(GATEWAY_READY_POLL_MS);
  }
  throw new Error(`Gateway did not become healthy within ${GATEWAY_READY_TIMEOUT_MS}ms`);
}

async function waitForGatewayReadyOrFailure(
  proc: ChildProcessWithoutNullStreams,
  port: number,
): Promise<void> {
  let settled = false;
  return await new Promise((resolve, reject) => {
    const finishResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const finishReject = (reason: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(reason);
    };
    const onError = (error: Error) => finishReject(new Error(`Gateway process spawn failed: ${error.message}`));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finishReject(
        new Error(
          `Gateway process exited before ready (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    const cleanup = () => {
      proc.off("error", onError);
      proc.off("exit", onExit);
    };

    proc.on("error", onError);
    proc.on("exit", onExit);

    void waitForGatewayReady(port).then(finishResolve).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      finishReject(new Error(message));
    });
  });
}

function attachGatewayProcessLogs(proc: ChildProcessWithoutNullStreams): void {
  const logPath = gatewayLogPath();
  ensureParentDir(logPath);
  const stream = fs.createWriteStream(logPath, { flags: "a" });
  proc.stdout.on("data", (data) => stream.write(data));
  proc.stderr.on("data", (data) => stream.write(data));
  proc.on("close", () => {
    stream.end();
  });
}

function setGatewayStatus(next: Partial<GatewayStatus>): void {
  gatewayStatus = { ...gatewayStatus, ...next };
  mainWindow?.webContents.send("gateway:status", gatewayStatus);
}

async function stopGatewayProcess(): Promise<void> {
  const proc = gatewayProcess;
  gatewayProcess = null;
  if (!proc) {
    setGatewayStatus({ state: "stopped", pid: null, startedAtMs: null });
    return;
  }

  const pid = proc.pid ?? null;
  setGatewayStatus({ state: "stopped", pid: null, startedAtMs: null });
  if (!pid) {
    return;
  }

  proc.kill("SIGTERM");
  const started = Date.now();
  while (Date.now() - started < GATEWAY_SHUTDOWN_TIMEOUT_MS) {
    if (proc.exitCode !== null) {
      return;
    }
    await sleep(200);
  }

  if (proc.exitCode === null) {
    proc.kill("SIGKILL");
  }
}

async function startGatewayProcess(options?: { retries?: number }): Promise<number> {
  const retries = options?.retries ?? 3;
  const nodeBinary = resolveNodeBinary();
  const entry = gatewayEntryPath();
  if (!fs.existsSync(entry)) {
    throw new Error(`Gateway entrypoint not found: ${entry}`);
  }

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const port = await findAvailablePort(DEFAULT_PORT + attempt);
      const args = [
        entry,
        "gateway",
        "--allow-unconfigured",
        "--bind",
        "loopback",
        "--port",
        String(port),
      ];
      const cwd = runtimeRootDir();

      setGatewayStatus({
        state: "starting",
        port,
        lastError: null,
      });

      const proc = spawn(nodeBinary, args, {
        cwd,
        stdio: "pipe",
        env: {
          ...process.env,
          OPENCLAW_SKIP_CHANNELS: "1",
          CLAWDBOT_SKIP_CHANNELS: "1",
        },
      });
      gatewayProcess = proc;
      setGatewayStatus({
        pid: proc.pid ?? null,
        startedAtMs: Date.now(),
      });
      attachGatewayProcessLogs(proc);

      proc.on("exit", (code, signal) => {
        if (gatewayProcess === proc) {
          gatewayProcess = null;
        }
        if (gatewayStatus.state !== "stopped") {
          setGatewayStatus({
            state: "error",
            pid: null,
            startedAtMs: null,
            lastError: `Gateway exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
          });
        }
      });

      await waitForGatewayReadyOrFailure(proc, port);
      setGatewayStatus({
        state: "ready",
        port,
        lastError: null,
      });
      return port;
    } catch (error) {
      await stopGatewayProcess();
      const message = error instanceof Error ? error.message : String(error);
      setGatewayStatus({
        state: "error",
        lastError: message,
      });
      if (attempt >= retries) {
        throw error;
      }
      await sleep(nextBackoffMs(attempt));
    }
  }

  throw new Error("Failed to start gateway process");
}

async function ensureMainWindow(): Promise<void> {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow = window;
  let didShowWindow = false;
  const showWindowOnce = () => {
    if (!didShowWindow && !window.isDestroyed()) {
      didShowWindow = true;
      window.show();
      window.focus();
    }
  };

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (!isLocalDashboardURL(url)) {
      event.preventDefault();
      if (url.startsWith("http://") || url.startsWith("https://")) {
        void shell.openExternal(url);
      }
    }
  });

  // Bind show handlers before navigation to avoid missing early ready events.
  window.once("ready-to-show", showWindowOnce);
  window.webContents.once("did-finish-load", showWindowOnce);
  setTimeout(showWindowOnce, 3_000);

  const port = gatewayStatus.port ?? (await startGatewayProcess());
  const dashboardUrl = await buildDashboardUrl(port);
  await window.loadURL(dashboardUrl);
  showWindowOnce();

  window.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle("gateway:get-status", async () => gatewayStatus);
  ipcMain.handle("gateway:restart", async () => {
    await stopGatewayProcess();
    const port = await startGatewayProcess({ retries: 2 });
    if (mainWindow) {
      const dashboardUrl = await buildDashboardUrl(port);
      await mainWindow.loadURL(dashboardUrl);
    }
    return gatewayStatus;
  });
  ipcMain.handle("gateway:open-logs", async () => {
    const logDir = path.dirname(gatewayLogPath());
    await shell.openPath(logDir);
    return logDir;
  });
  ipcMain.handle("app:get-runtime-info", async () => {
    return {
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      nodeBinary: resolveNodeBinary(),
      runtimeRoot: runtimeRootDir(),
      packaged: isPackagedApp(),
    };
  });
}

async function boot(): Promise<void> {
  registerIpcHandlers();
  try {
    await startGatewayProcess({ retries: 2 });
    await ensureMainWindow();
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    let logTail = "";
    try {
      const logPath = gatewayLogPath();
      if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, "utf8");
        const lines = content.split(/\r?\n/).filter(Boolean);
        logTail = lines.slice(-30).join("\n");
      }
    } catch {
      // ignore log tail read failures
    }
    setGatewayStatus({
      state: "error",
      lastError: logTail ? `${detail}\n\nGateway log (tail):\n${logTail}` : detail,
    });
    await dialog.showErrorBox(
      "OpenClaw 启动失败",
      logTail ? `${detail}\n\nGateway log (tail):\n${logTail}` : detail,
    );
    app.quit();
  }
}

app.on("ready", () => {
  void boot();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void ensureMainWindow();
  }
});

app.on("before-quit", () => {
  void stopGatewayProcess();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
