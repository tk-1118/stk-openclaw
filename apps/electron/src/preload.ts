import { contextBridge, ipcRenderer } from "electron";

export interface GatewayStatus {
  state: "stopped" | "starting" | "ready" | "error";
  port: number | null;
  pid: number | null;
  startedAtMs: number | null;
  lastError: string | null;
}

const api = {
  getGatewayStatus: (): Promise<GatewayStatus> => ipcRenderer.invoke("gateway:get-status"),
  restartGateway: (): Promise<GatewayStatus> => ipcRenderer.invoke("gateway:restart"),
  openGatewayLogs: (): Promise<string> => ipcRenderer.invoke("gateway:open-logs"),
  getRuntimeInfo: (): Promise<Record<string, string | boolean>> =>
    ipcRenderer.invoke("app:get-runtime-info"),
  onGatewayStatus: (handler: (status: GatewayStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: GatewayStatus) => handler(payload);
    ipcRenderer.on("gateway:status", listener);
    return () => ipcRenderer.removeListener("gateway:status", listener);
  },
};

contextBridge.exposeInMainWorld("openclawDesktop", api);
