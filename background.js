import { accessOrigins, isNewer, joinUrl, loadRemoteConfig } from "./config.js";
import { diffPositions, renderMessages } from "./diff.js";

const ALARM = "positions";
const EMPTY_STATE = {
  linked: false,
  siteUserId: null,
  lastSnapshot: null,
  jwtHash: null,
  pendingCode: null,
  lastError: null,
  notifiedVersion: null,
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) {
    poll();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "getStatus") {
    collectStatus().then(sendResponse);
    return true;
  }
  if (message?.type === "poll") {
    poll().then(sendResponse);
    return true;
  }
  if (message?.type === "link") {
    linkTelegram(message.jwt)
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error instanceof Error ? error.message : "Не удалось открыть Telegram" }));
    return true;
  }
  return false;
});

chrome.alarms.create(ALARM, { periodInMinutes: 1 });

let running = null;

function poll() {
  if (!running) {
    running = pollOnce().finally(() => {
      running = null;
    });
  }
  return running;
}

async function getState() {
  return chrome.storage.local.get(EMPTY_STATE);
}

async function collectStatus() {
  const state = await getState();
  let config = null;
  let configError = null;
  try {
    config = await loadRemoteConfig();
  } catch (error) {
    configError = error instanceof Error ? error.message : "Конфигурация недоступна";
  }
  const version = chrome.runtime.getManifest().version;
  const update = config && isNewer(config.update.latestVersion, version)
    ? config.update
    : null;
  let permissionGranted = false;
  if (config) {
    permissionGranted = await chrome.permissions.contains({ origins: accessOrigins(config) });
  }
  return {
    linked: state.linked,
    pending: Boolean(state.pendingCode),
    siteUserId: state.siteUserId,
    lastError: state.lastError,
    configError,
    permissionGranted,
    backend: config?.backend.baseUrl || null,
    update,
    version,
  };
}

async function pollOnce() {
  try {
    const config = await loadRemoteConfig();
    await maybeNotifyUpdate(config);
    const granted = await chrome.permissions.contains({ origins: accessOrigins(config) });
    if (!granted) {
      await chrome.storage.local.set({ lastError: "Нужен доступ к кабинету и стенду. Откройте расширение." });
      return { ok: false };
    }
    const jwt = await readJwt(config.whitelist.positionUrl);
    if (!jwt) {
      await chrome.storage.local.set({ lastError: "Cookie jwt не найдена. Войдите на сайт." });
      return { ok: false };
    }
    const state = await getState();
    const jwtHash = await digest(jwt);
    if (state.linked && state.jwtHash && state.jwtHash !== jwtHash) {
      await refreshToken(config, jwt);
    }
    if (state.pendingCode) {
      await checkPendingLink(config, state.pendingCode);
    }
    const positions = await fetchPositions(config.whitelist.positionUrl, jwt);
    const events = state.lastSnapshot ? diffPositions(state.lastSnapshot, positions) : [];
    await chrome.storage.local.set({
      lastSnapshot: positions,
      jwtHash,
      lastError: null,
    });
    const fresh = await getState();
    if (!fresh.linked && state.lastSnapshot && events.length) {
      notifyPositions(events);
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ошибка опроса";
    await chrome.storage.local.set({ lastError: message });
    return { ok: false, error: message };
  }
}

async function maybeNotifyUpdate(config) {
  const version = chrome.runtime.getManifest().version;
  if (!isNewer(config.update.latestVersion, version)) return;
  const state = await getState();
  if (state.notifiedVersion === config.update.latestVersion) return;
  const notes = config.update.notes ? `\n${config.update.notes}` : "";
  chrome.notifications.create(`wl-update-${config.update.latestVersion}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon128.png"),
    title: "Доступна новая версия расширения",
    message: `Сейчас ${version}, опубликована ${config.update.latestVersion}.${notes}`.slice(0, 500),
  });
  await chrome.storage.local.set({ notifiedVersion: config.update.latestVersion });
}

async function linkTelegram(jwt) {
  const config = await loadRemoteConfig();
  const response = await fetch(joinUrl(config.backend.baseUrl, config.backend.pairPath), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jwt, relink: true }),
  });
  if (!response.ok) {
    throw new Error(`Стенд ответил ${response.status}`);
  }
  const payload = await response.json();
  await chrome.storage.local.set({
    siteUserId: payload.siteUserId || null,
    jwtHash: await digest(jwt),
    lastError: null,
  });
  if (!payload.deepLink || !payload.code) {
    if (payload.linked) {
      await chrome.storage.local.set({ linked: true, pendingCode: null });
      return payload;
    }
    throw new Error("Стенд не вернул ссылку");
  }
  await chrome.storage.local.set({ pendingCode: payload.code, linked: Boolean(payload.linked) });
  await chrome.tabs.create({ url: payload.deepLink });
  return { pending: true, siteUserId: payload.siteUserId };
}

async function refreshToken(config, jwt) {
  const response = await fetch(joinUrl(config.backend.baseUrl, config.backend.pairPath), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jwt, relink: false }),
  });
  if (!response.ok) {
    throw new Error(`Не удалось обновить токен: ${response.status}`);
  }
  const payload = await response.json();
  await chrome.storage.local.set({
    linked: Boolean(payload.linked),
    siteUserId: payload.siteUserId || null,
  });
}

async function checkPendingLink(config, code) {
  const statusUrl = `${joinUrl(config.backend.baseUrl, config.backend.pairPath)}/${encodeURIComponent(code)}`;
  const response = await fetch(statusUrl, { headers: { Accept: "application/json" } });
  if (response.status === 404) {
    await chrome.storage.local.set({ pendingCode: null, lastError: "Код привязки не найден" });
    return;
  }
  if (!response.ok) return;
  const payload = await response.json();
  if (payload.linked) {
    await chrome.storage.local.set({ linked: true, pendingCode: null, lastError: null });
    return;
  }
  if (payload.expired) {
    await chrome.storage.local.set({ pendingCode: null, lastError: "Срок кода истёк. Запросите ссылку снова." });
    return;
  }
  if (payload.used) {
    await chrome.storage.local.set({ pendingCode: null, lastError: "Привязка отменена." });
  }
}

async function fetchPositions(positionUrl, jwt) {
  const host = new URL(positionUrl).hostname;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [
      {
        id: 1,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "cookie", operation: "append", value: `jwt=${jwt}` }],
        },
        condition: {
          urlFilter: `||${host}/`,
          resourceTypes: ["xmlhttprequest", "other"],
        },
      },
    ],
  });
  let response;
  try {
    response = await fetch(positionUrl, {
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
  } finally {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1] });
  }
  if (response.status === 401) {
    throw new Error("Токен кабинета не принят");
  }
  if (!response.ok) {
    throw new Error(`Кабинет ответил ${response.status}`);
  }
  const payload = await response.json();
  if (!payload || typeof payload !== "object") {
    throw new Error("Неожиданный ответ кабинета");
  }
  return payload;
}

async function readJwt(positionUrl) {
  const urls = [positionUrl];
  const host = new URL(positionUrl).hostname.split(".");
  if (host.length > 2) {
    urls.push(`https://${host.slice(1).join(".")}/`);
  }
  for (const url of urls) {
    const cookie = await chrome.cookies.get({ url, name: "jwt" });
    if (cookie?.value) return cookie.value;
  }
  return null;
}

function notifyPositions(events) {
  const text = renderMessages(events).join("\n\n");
  chrome.notifications.create(`wl-pos-${Date.now()}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon128.png"),
    title: "Позиции Whitelist",
    message: text.slice(0, 500) || "Позиции изменились",
  });
}

async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  const buffer = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buffer)].map((item) => item.toString(16).padStart(2, "0")).join("");
}
