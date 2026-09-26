import { invoke } from "@tauri-apps/api/core";
import type {
  AutomationRuntimeConfigInput,
  AutomationRuntimeState,
  BrowserProfile,
  CreateGenerationJobInput,
  CreateProfileInput,
  GenerationJob,
  LocalApiState,
  ProfileOperationalState,
  ProxyCheckResult,
  ProxyPoolItem,
  ProxyPoolItemInput,
  ProxyPoolState,
  SchedulerState,
  SystemInfo,
  UpdateGenerationJobInput,
  UpdateProfileOperationalStateInput,
  WorkerState,
  Workspace,
} from "./types";

const isTauri = () => "__TAURI_INTERNALS__" in window;

export async function getSystemInfo(): Promise<SystemInfo> {
  if (!isTauri()) {
    return {
      chromePath: null,
      dataDir: "Desktop app data directory",
      maxSimultaneousProfiles: 4,
    };
  }
  return invoke<SystemInfo>("get_system_info");
}

export async function listProfiles(): Promise<BrowserProfile[]> {
  if (!isTauri()) return [];
  return invoke<BrowserProfile[]>("list_profiles");
}

export async function createProfile(
  request: CreateProfileInput,
): Promise<BrowserProfile> {
  return invoke<BrowserProfile>("create_profile", { request });
}

export async function deleteProfile(profileId: string): Promise<void> {
  return invoke("delete_profile", { profileId });
}

export async function openProfiles(profileIds: string[]): Promise<string[]> {
  return invoke<string[]>("open_profiles", {
    profileIds,
    startUrl: "https://www.google.com/",
  });
}

export async function openSmartProfiles(count = 4): Promise<string[]> {
  return invoke<string[]>("open_smart_profiles", {
    count,
    startUrl: "https://www.google.com/",
  });
}

export async function closeProfile(profileId: string): Promise<void> {
  return invoke("close_profile", { profileId });
}

export async function getSchedulerState(): Promise<SchedulerState> {
  if (!isTauri()) {
    return { enabled: false, readyProfiles: 0, blockedProfiles: 0 };
  }
  return invoke<SchedulerState>("get_scheduler_state");
}

export async function setSchedulerEnabled(enabled: boolean): Promise<SchedulerState> {
  return invoke<SchedulerState>("set_scheduler_enabled", { enabled });
}

export async function updateProfileOperationalState(
  profileId: string,
  request: UpdateProfileOperationalStateInput,
): Promise<ProfileOperationalState> {
  return invoke<ProfileOperationalState>("update_profile_operational_state", {
    profileId,
    request,
  });
}

export async function clearProfileOperationalBlocks(
  profileId: string,
): Promise<ProfileOperationalState> {
  return invoke<ProfileOperationalState>("clear_profile_operational_blocks", {
    profileId,
  });
}

export async function getProxyPoolState(): Promise<ProxyPoolState> {
  if (!isTauri()) return { enabled: false, items: [] };
  return invoke<ProxyPoolState>("get_proxy_pool_state");
}

export async function setProxyPoolEnabled(enabled: boolean): Promise<ProxyPoolState> {
  return invoke<ProxyPoolState>("set_proxy_pool_enabled", { enabled });
}

export async function createProxyPoolItem(
  request: ProxyPoolItemInput,
): Promise<ProxyPoolItem> {
  return invoke<ProxyPoolItem>("create_proxy_pool_item", { request });
}

export async function updateProxyPoolItem(
  proxyId: string,
  request: ProxyPoolItemInput,
): Promise<ProxyPoolItem> {
  return invoke<ProxyPoolItem>("update_proxy_pool_item", { proxyId, request });
}

export async function deleteProxyPoolItem(proxyId: string): Promise<void> {
  return invoke("delete_proxy_pool_item", { proxyId });
}

export async function testProxyPoolItem(proxyId: string): Promise<ProxyCheckResult> {
  return invoke<ProxyCheckResult>("test_proxy_pool_item", { proxyId });
}

export async function rotateProxyPoolItem(proxyId: string): Promise<ProxyCheckResult> {
  return invoke<ProxyCheckResult>("rotate_proxy_pool_item", { proxyId });
}

export async function listGenerationJobs(): Promise<GenerationJob[]> {
  if (!isTauri()) return [];
  return invoke<GenerationJob[]>("list_generation_jobs");
}

export async function createGenerationJob(
  request: CreateGenerationJobInput,
): Promise<GenerationJob> {
  return invoke<GenerationJob>("create_generation_job", { request });
}

export async function updateGenerationJob(
  jobId: string,
  request: UpdateGenerationJobInput,
): Promise<GenerationJob> {
  return invoke<GenerationJob>("update_generation_job", { jobId, request });
}

export async function cancelGenerationJob(jobId: string): Promise<GenerationJob> {
  return invoke<GenerationJob>("cancel_generation_job", { jobId });
}

export async function getLocalApiState(): Promise<LocalApiState> {
  if (!isTauri()) {
    return {
      enabled: false,
      running: false,
      port: 8787,
      baseUrl: "http://127.0.0.1:8787",
      apiKeyPreview: "dola_••••",
    };
  }
  return invoke<LocalApiState>("get_local_api_state");
}

export async function setLocalApiEnabled(enabled: boolean): Promise<LocalApiState> {
  return invoke<LocalApiState>("set_local_api_enabled", { enabled });
}

export async function setLocalApiPort(port: number): Promise<LocalApiState> {
  return invoke<LocalApiState>("set_local_api_port", { port });
}

export async function revealLocalApiKey(): Promise<string> {
  return invoke<string>("reveal_local_api_key");
}

export async function rotateLocalApiKey(): Promise<string> {
  return invoke<string>("rotate_local_api_key");
}

export async function getWorkerState(): Promise<WorkerState> {
  if (!isTauri()) {
    return {
      enabled: false,
      running: false,
      mode: "allocation_only",
      maxConcurrentJobs: 4,
      pollIntervalMs: 1000,
      activeAssignments: 0,
      queuedJobs: 0,
      lastTickAt: null,
      lastError: null,
    };
  }
  return invoke<WorkerState>("get_worker_state");
}

export async function setWorkerEnabled(enabled: boolean): Promise<WorkerState> {
  return invoke<WorkerState>("set_worker_enabled", { enabled });
}

export async function runWorkerTick(): Promise<number> {
  return invoke<number>("run_worker_tick");
}

export async function getAutomationRuntimeState(): Promise<AutomationRuntimeState> {
  if (!isTauri()) {
    return {
      running: false,
      pid: null,
      concurrency: 1,
      timeoutSeconds: 1200,
      manualVerificationSeconds: 180,
      nodePath: null,
      scriptPath: null,
      logPath: null,
      startedAt: null,
      lastError: null,
    };
  }
  return invoke<AutomationRuntimeState>("get_automation_runtime_state");
}

export async function setAutomationRuntimeEnabled(
  enabled: boolean,
): Promise<AutomationRuntimeState> {
  return invoke<AutomationRuntimeState>("set_automation_runtime_enabled", { enabled });
}

export async function updateAutomationRuntimeConfig(
  request: AutomationRuntimeConfigInput,
): Promise<AutomationRuntimeState> {
  return invoke<AutomationRuntimeState>("update_automation_runtime_config", { request });
}

export async function getAutomationRuntimeLog(maxBytes = 16000): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("get_automation_runtime_log", { maxBytes });
}

export async function listWorkspaces(): Promise<Workspace[]> {
  if (!isTauri()) return [];
  return invoke<Workspace[]>("list_workspaces");
}

export async function createWorkspace(
  name: string,
  profileIds: string[],
): Promise<Workspace> {
  return invoke<Workspace>("create_workspace", {
    request: { name, profileIds },
  });
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  return invoke("delete_workspace", { workspaceId });
}
