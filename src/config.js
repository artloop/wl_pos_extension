import { ANISCAN } from "./aniscan.js";

export const CONFIG_URL =
  "https://raw.githubusercontent.com/artloop/wl_pos_extension/main/remote-config.json";

export function parseConfig(data) {
  if (!data || data.schemaVersion !== 2) {
    throw new Error("Неизвестная схема конфигурации");
  }
  const baseUrl = data.backend?.baseUrl;
  const sessionPath = data.backend?.sessionPath;
  const channelPath = data.backend?.channelPath;
  const pulsePath = data.backend?.pulsePath || "";
  const publicKey = data.backend?.publicKey;
  const positionUrl = data.whitelist?.positionUrl;
  const latestVersion = data.update?.latestVersion;
  if (!baseUrl || !sessionPath || !channelPath || !publicKey || !positionUrl || !latestVersion) {
    throw new Error("В конфигурации нет адресов");
  }
  return {
    schemaVersion: 2,
    backend: { baseUrl, sessionPath, channelPath, pulsePath, publicKey },
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

export function cabinetUrl(positionUrl) {
  const parsed = new URL(positionUrl);
  const labels = parsed.hostname.split(".");
  const host = labels.length > 2 ? labels.slice(1).join(".") : parsed.hostname;
  return `${parsed.protocol}//${host}/`;
}

export function aniscanOrigins() {
  return [...new Set([ANISCAN.siteUrl, ANISCAN.accountUrl, ANISCAN.socketUrl].map(originPattern))];
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

export function accessDeniedMessage({ cabinet = false, aniscan = false } = {}) {
  const names = [];
  if (cabinet) names.push("кабинету", "стенду");
  if (aniscan) names.push("AniScan");
  if (!names.length) return "";
  if (names.length === 1) return `Нужен доступ к ${names[0]}. Откройте расширение.`;
  const tail = names.pop();
  return `Нужен доступ к ${names.join(", ")} и ${tail}. Откройте расширение.`;
}

export function signInPrompts(state) {
  if (!state) return [];
  const lines = [];
  if (state.accessError) lines.push({ text: state.accessError });
  if (state.permissionGranted && !state.cabinetOpen && state.cabinetUrl) {
    lines.push({ text: "Чтобы видеть позиции, войдите в кабинет.", href: state.cabinetUrl });
  }
  if (state.robotsEnabled && state.aniscanPermission && state.aniscanUrl && !state.aniscanOpen) {
    lines.push({ text: "Чтобы следить за роботами, войдите в AniScan.", href: state.aniscanUrl });
  }
  return lines;
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
