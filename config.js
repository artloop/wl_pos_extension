export const CONFIG_URL =
  "https://raw.githubusercontent.com/artloop/wl_pos_extension/main/remote-config.json";

export function parseConfig(data) {
  if (!data || data.schemaVersion !== 1) {
    throw new Error("Неизвестная схема конфигурации");
  }
  const baseUrl = data.backend?.baseUrl;
  const pairPath = data.backend?.pairPath;
  const positionUrl = data.whitelist?.positionUrl;
  const latestVersion = data.update?.latestVersion;
  if (!baseUrl || !pairPath || !positionUrl || !latestVersion) {
    throw new Error("В конфигурации нет адресов");
  }
  return {
    schemaVersion: 1,
    backend: { baseUrl, pairPath },
    whitelist: { positionUrl },
    update: {
      latestVersion,
      notes: data.update?.notes || "",
      downloadUrl: data.update?.downloadUrl || "",
    },
  };
}

export async function loadRemoteConfig() {
  const response = await fetch(CONFIG_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Конфигурация GitHub: ${response.status}`);
  }
  return parseConfig(await response.json());
}

export function joinUrl(base, path) {
  const normalized = base.endsWith("/") ? base.slice(0, -1) : base;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${normalized}${suffix}`;
}

export function originPattern(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}/*`;
}

export function accessOrigins(config) {
  const origins = new Set([
    originPattern(config.backend.baseUrl),
    originPattern(config.whitelist.positionUrl),
  ]);
  const host = new URL(config.whitelist.positionUrl).hostname.split(".");
  if (host.length > 2) {
    origins.add(`https://${host.slice(1).join(".")}/*`);
  }
  return [...origins];
}

export function isNewer(latest, current) {
  const left = String(latest).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = String(current).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta > 0) return true;
    if (delta < 0) return false;
  }
  return false;
}
