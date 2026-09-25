import { invoke } from "@tauri-apps/api/core";
import type {
  BrowserProfile,
  CreateProfileInput,
  ProxyCheckResult,
  ProxySettings,
  ProxySettingsInput,
  SystemInfo,
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

export async function updateProfileProxy(
  profileId: string,
  request: ProxySettingsInput,
): Promise<ProxySettings> {
  return invoke<ProxySettings>("update_profile_proxy", { profileId, request });
}

export async function testProfileProxy(profileId: string): Promise<ProxyCheckResult> {
  return invoke<ProxyCheckResult>("test_profile_proxy", { profileId });
}

export async function rotateProfileProxy(profileId: string): Promise<ProxyCheckResult> {
  return invoke<ProxyCheckResult>("rotate_profile_proxy", { profileId });
}

export async function openProfiles(profileIds: string[]): Promise<string[]> {
  return invoke<string[]>("open_profiles", {
    profileIds,
    startUrl: "https://www.google.com/",
  });
}

export async function closeProfile(profileId: string): Promise<void> {
  return invoke("close_profile", { profileId });
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
