export type ProxySettings = {
  enabled: boolean;
  protocol: "http" | "https" | "socks5";
  host: string;
  port: number;
  authUsername: string | null;
  rotationMode: "sticky" | "rotate_on_launch" | "manual";
  rotationUrl: string | null;
  lastIp: string | null;
  health: "disabled" | "unchecked" | "healthy" | "offline";
  lastLatencyMs: number | null;
  lastCheckedAt: string | null;
};

export type ProxySettingsInput = Pick<
  ProxySettings,
  | "enabled"
  | "protocol"
  | "host"
  | "port"
  | "authUsername"
  | "rotationMode"
  | "rotationUrl"
>;

export type ProxyCheckResult = {
  reachable: boolean;
  publicIp: string | null;
  latencyMs: number | null;
  checkedAt: string;
  message: string;
};

export type ProxyPoolItem = {
  id: string;
  name: string;
  enabled: boolean;
  protocol: "http" | "https" | "socks5";
  host: string;
  port: number;
  authUsername: string | null;
  rotationUrl: string | null;
  lastIp: string | null;
  health: "unchecked" | "healthy" | "offline";
  lastLatencyMs: number | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProxyPoolItemInput = Pick<
  ProxyPoolItem,
  "name" | "enabled" | "protocol" | "host" | "port" | "authUsername" | "rotationUrl"
>;

export type ProxyPoolState = {
  enabled: boolean;
  items: ProxyPoolItem[];
};

export type ActiveProxyAssignment = {
  proxyId: string;
  proxyName: string;
  endpoint: string;
  publicIp: string | null;
  assignedAt: string;
};

export type BrowserProfile = {
  id: string;
  name: string;
  email: string | null;
  groupName: string | null;
  services: string[];
  tags: string[];
  notes: string | null;
  profilePath: string;
  proxy: ProxySettings;
  activeProxy: ActiveProxyAssignment | null;
  isRunning: boolean;
  pid: number | null;
  lastOpenedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Workspace = {
  id: string;
  name: string;
  profileIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type SystemInfo = {
  chromePath: string | null;
  dataDir: string;
  maxSimultaneousProfiles: number;
};

export type CreateProfileInput = {
  name: string;
  email?: string | null;
  groupName?: string | null;
  services: string[];
  tags: string[];
  notes?: string | null;
};
