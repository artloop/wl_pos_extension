import { accessOrigins, isNewer, joinUrl, loadRemoteConfig, originPattern } from "./config.js";
import { openChannel, openSessionResponse, readSub, sealChannel, sealSessionRequest, sealToServer } from "./channel.js";
import { diffPositions, renderMessages } from "./diff.js";
import { marketClosed } from "./hours.js";
import { rememberHistory, restoreHistory } from "./history.js";
import { NOTIFY_OPTIONS, filterEvents } from "./notify-prefs.js";

const ALARM = "positions";
const DESK_KEY = "deskWindowId";
const HISTORY_KEY = "positionHistory";
const LIVE_PORT = "positions";
const LIVE_POLL_MS = 10000;
const viewers = new Set();
let liveTimer = null;
let history = [];
let historyReady = null;
const SESSION_KEYS = ["sessionId", "sessionKey", "sessionExpires", "channelSeq", "sessionSiteUserId"];
const EMPTY_STATE = {
  linked: false,
  siteUserId: null,
  lastSnapshot: null,
  snapshotAt: null,
  jwtHash: null,
  pendingCode: null,
  lastError: null,
  notifiedVersion: null,
  unseenChanges: 0,
  prefsOwner: null,
  prefsRevision: null,
  prefsDirty: false,
  prefsConflict: false,
  prefsKnown: false,
  shareWithServer: false,
  browserBanners: true,
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM || liveTimer != null) return;
  return poll();
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
  if (message?.type === "seen") {
    clearBadge().then(sendResponse);
    return true;
  }
  if (message?.type === "link") {
    linkTelegram(message.jwt)
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error instanceof Error ? error.message : "Не удалось открыть Telegram" }));
    return true;
  }
  if (message?.type === "prefsChanged") {
    pushPrefs()
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error instanceof Error ? error.message : "Не удалось сохранить настройки" }));
    return true;
  }
  if (message?.type === "resolvePrefs") {
    resolvePrefs(message.choice)
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error instanceof Error ? error.message : "Не удалось синхронизировать настройки" }));
    return true;
  }
  if (message?.type === "setShare") {
    setShare(Boolean(message.enabled))
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error instanceof Error ? error.message : "Не удалось изменить сохранение на сервере" }));
    return true;
  }
  if (message?.type === "openDesk") {
    openDesk()
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error instanceof Error ? error.message : "Не удалось открыть окно" }));
    return true;
  }
  if (message?.type === "getHistory") {
    readHistory().then((entries) => sendResponse({ history: entries }));
    return true;
  }
  return false;
});

chrome.windows.onRemoved.addListener((windowId) => {
  chrome.storage.session.get(DESK_KEY).then((stored) => {
    if (stored[DESK_KEY] === windowId) chrome.storage.session.remove(DESK_KEY);
  });
});

chrome.alarms.create(ALARM, { periodInMinutes: 1 });
loadHistory();
reportPresence();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== LIVE_PORT) return;
  viewers.add(port);
  port.onDisconnect.addListener(() => {
    viewers.delete(port);
    if (viewers.size === 0 && liveTimer != null) {
      clearInterval(liveTimer);
      liveTimer = null;
    }
  });
  if (liveTimer == null) liveTimer = setInterval(() => poll(), LIVE_POLL_MS);
});

let running = null;
let channelLock = Promise.resolve();

function loadHistory() {
  if (!historyReady) {
    historyReady = chrome.storage.local
      .get(HISTORY_KEY)
      .then((stored) => {
        history = restoreHistory(stored[HISTORY_KEY]);
      })
      .catch((error) => {
        historyReady = null;
        console.error("История не прочиталась:", error instanceof Error ? error.message : "Ошибка чтения");
        throw error;
      });
  }
  return historyReady;
}

async function readHistory() {
  try {
    await loadHistory();
  } catch {
    return history;
  }
  return history;
}

async function appendHistory(events, at) {
  await loadHistory();
  const next = history.slice();
  rememberHistory(next, events, at);
  try {
    await chrome.storage.local.set({ [HISTORY_KEY]: next });
  } catch (error) {
    console.error("История не сохранилась:", error instanceof Error ? error.message : "Ошибка записи");
    throw error;
  }
  history = next;
}

function poll() {
  if (!running) {
    running = pollOnce().finally(() => {
      running = null;
    });
  }
  return running;
}

function withChannel(task) {
  const run = channelLock.then(task, task);
  channelLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function getState() {
  return chrome.storage.local.get(EMPTY_STATE);
}

async function ensureShare() {
  const stored = await chrome.storage.local.get(["shareWithServer", "linked", "pendingCode", "jwtHash"]);
  if (stored.linked || stored.pendingCode) {
    if (stored.shareWithServer !== true) await chrome.storage.local.set({ shareWithServer: true });
    return true;
  }
  if (typeof stored.shareWithServer === "boolean") return stored.shareWithServer;
  if (stored.jwtHash) {
    await chrome.storage.local.set({ shareWithServer: true });
    return true;
  }
  return false;
}

async function currentShare() {
  const stored = await chrome.storage.local.get(["shareWithServer", "linked", "pendingCode"]);
  if (stored.linked || stored.pendingCode) return true;
  return stored.shareWithServer === true;
}

async function setShare(enabled) {
  const state = await getState();
  if (!enabled && (state.linked || state.pendingCode)) {
    await chrome.storage.local.set({ shareWithServer: true });
    return { ok: true, locked: true, shareWithServer: true };
  }
  if (enabled) {
    await chrome.storage.local.set({ shareWithServer: true });
    const config = await loadRemoteConfig();
    const granted = await chrome.permissions.contains({ origins: accessOrigins(config) });
    if (!granted) {
      return { ok: false, shareWithServer: true, error: "Нужен доступ к кабинету и стенду. Откройте расширение." };
    }
    const jwt = await readJwt(config.whitelist.positionUrl);
    if (!jwt) return { ok: false, shareWithServer: true, error: "Cookie jwt не найдена. Войдите на сайт." };
    await syncBackend(config, jwt);
    return { ok: true, shareWithServer: true };
  }
  const forgotten = await forgetServer();
  if (!forgotten) return { ok: true, locked: true, shareWithServer: true };
  return { ok: true, shareWithServer: false };
}

async function forgetServer() {
  const prior = await chrome.storage.local.get(["jwtHash", "linked", "pendingCode"]);
  if (prior.linked || prior.pendingCode) {
    await chrome.storage.local.set({ shareWithServer: true });
    return false;
  }
  const config = await loadRemoteConfig();
  const granted = await chrome.permissions.contains({ origins: accessOrigins(config) });
  const jwt = granted ? await readJwt(config.whitelist.positionUrl) : null;
  let toldServer = false;
  if (jwt) {
    const payload = await syncBackend(config, jwt, { consent: false });
    if (payload?.linked) {
      await chrome.storage.local.set({ shareWithServer: true });
      return false;
    }
    toldServer = true;
  } else if (granted) {
    const stored = await chrome.storage.session.get(SESSION_KEYS);
    const alive = stored.sessionId && stored.sessionKey && Number(stored.sessionExpires) > Date.now() + 5000;
    if (alive) {
      try {
        const payload = await withChannel(() => postChannel(config, stored, { consent: false }));
        if (payload?.linked) {
          await chrome.storage.local.set({ shareWithServer: true });
          return false;
        }
        toldServer = true;
      } catch (error) {
        if (!error.relogin) throw error;
      }
    }
  }
  if (prior.jwtHash && !toldServer) {
    throw new Error("Не удалось стереть данные на стенде. Войдите на сайт и снимите галочку снова.");
  }
  await clearSession();
  await chrome.storage.local.set({
    shareWithServer: false,
    prefsRevision: null,
    prefsConflict: false,
    prefsDirty: true,
  });
  return true;
}

async function collectStatus() {
  const share = await ensureShare();
  const state = await getState();
  let config = null;
  let configError = null;
  try {
    config = await loadRemoteConfig();
  } catch (error) {
    configError = error instanceof Error ? error.message : "Конфигурация недоступна";
  }
  const version = chrome.runtime.getManifest().version;
  const update = config && isNewer(config.update.latestVersion, version) ? config.update : null;
  let permissionGranted = false;
  if (config) {
    permissionGranted = await chrome.permissions.contains({ origins: accessOrigins(config) });
  }
  return {
    linked: state.linked,
    pending: Boolean(state.pendingCode),
    siteUserId: state.siteUserId,
    lastError: state.lastError,
    notificationsDenied: !(await browserNotificationsGranted()),
    browserBanners: state.browserBanners !== false,
    lastSnapshot: state.lastSnapshot,
    snapshotAt: state.snapshotAt,
    configError,
    permissionGranted,
    backend: Boolean(config?.backend.baseUrl),
    prefsConflict: Boolean(state.prefsConflict) && share,
    shareWithServer: share,
    shareLocked: Boolean(state.linked || state.pendingCode),
    update,
    version,
  };
}

async function pollOnce() {
  let syncError = null;
  try {
    const config = await loadRemoteConfig();
    await maybeNotifyUpdate(config);
    const share = await ensureShare();
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
    if (share) {
      try {
        await syncBackend(config, jwt);
      } catch (error) {
        syncError = error instanceof Error ? error.message : "Ошибка связи со стендом";
      }
    }
    if (marketClosed()) {
      console.info("До 06:00 МСК позиции не запрашиваю: биржа закрыта");
      if (syncError) await chrome.storage.local.set({ lastError: syncError });
      else if (!share) await chrome.storage.local.set({ lastError: null });
      return { ok: !syncError, error: syncError };
    }
    const state = await getState();
    const positions = await fetchPositions(config.whitelist.positionUrl, jwt);
    const events = state.lastSnapshot ? diffPositions(state.lastSnapshot, positions) : [];
    if (state.lastSnapshot && events.length) await appendHistory(events, Date.now());
    const fresh = await getState();
    if (!state.lastSnapshot) {
      console.info("Позиции: первая загрузка, уведомление не отправляю");
    } else if (!events.length) {
      console.info("Позиции без изменений");
    } else {
      const text = renderMessages(events).join("\n\n");
      console.info(`Позиции изменились\n${text}`);
      if (fresh.linked) {
        console.info("Системное уведомление выключено: кабинет привязан к Telegram");
        await clearBadge();
      } else {
        const visible = filterEvents(events, await readNotifyPrefs());
        if (!visible.length) {
          console.info("Оповещение скрыто настройками");
        } else if (fresh.browserBanners !== false && (await browserNotificationsGranted())) {
          await notifyPositions(visible);
        } else {
          await markUnseen(visible.length);
        }
      }
    }
    await chrome.storage.local.set({
      lastSnapshot: positions,
      snapshotAt: Date.now(),
      ...(syncError ? { lastError: syncError } : share ? {} : { lastError: null }),
    });
    return { ok: !syncError, error: syncError };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ошибка опроса";
    console.error("Опрос позиций:", message);
    await chrome.storage.local.set({ lastError: syncError || message });
    return { ok: false, error: message };
  }
}

async function openDesk() {
  const stored = await chrome.storage.session.get(DESK_KEY);
  const existing = stored[DESK_KEY];
  if (existing != null) {
    try {
      await chrome.windows.update(existing, { focused: true });
      return { ok: true };
    } catch {
      await chrome.storage.session.remove(DESK_KEY);
    }
  }
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL("ui/desk.html"),
    type: "popup",
    width: 960,
    height: 720,
    focused: true,
  });
  if (created?.id != null) await chrome.storage.session.set({ [DESK_KEY]: created.id });
  return { ok: true };
}

async function maybeNotifyUpdate(config) {
  const version = chrome.runtime.getManifest().version;
  if (!isNewer(config.update.latestVersion, version)) return;
  const state = await getState();
  if (state.notifiedVersion === config.update.latestVersion) return;
  const notes = config.update.notes ? `\n${config.update.notes}` : "";
  await chrome.notifications.create(`wl-update-${config.update.latestVersion}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "Доступна новая версия расширения",
    message: `Сейчас ${version}, опубликована ${config.update.latestVersion}.${notes}`.slice(0, 500),
  });
  await chrome.storage.local.set({ notifiedVersion: config.update.latestVersion });
}

async function linkTelegram(jwt) {
  await chrome.storage.local.set({ shareWithServer: true });
  const config = await loadRemoteConfig();
  const payload = await syncBackend(config, jwt, { pair: { relink: true } });
  if (payload?.pair?.deepLink) {
    await chrome.tabs.create({ url: payload.pair.deepLink });
    return { pending: true, siteUserId: payload.siteUserId };
  }
  throw new Error("Стенд не вернул ссылку");
}

async function pushPrefs() {
  if (!(await ensureShare())) return { ok: true };
  const state = await getState();
  if (state.prefsConflict) return { ok: true };
  const config = await loadRemoteConfig();
  const granted = await chrome.permissions.contains({ origins: accessOrigins(config) });
  if (!granted) return { ok: false };
  const jwt = await readJwt(config.whitelist.positionUrl);
  if (!jwt) return { ok: false };
  await syncBackend(config, jwt);
  return { ok: true };
}

async function resolvePrefs(choice) {
  if (!(await ensureShare())) throw new Error("Сохранение на сервере выключено");
  const config = await loadRemoteConfig();
  const jwt = await readJwt(config.whitelist.positionUrl);
  if (!jwt) throw new Error("Cookie jwt не найдена. Войдите на сайт.");
  await syncBackend(config, jwt, { intent: choice === "push" ? "resolve-push" : "resolve-pull" });
  return { ok: true };
}

async function syncBackend(config, jwt, extra = {}) {
  return withChannel(() => syncLocked(config, jwt, extra));
}

async function syncLocked(config, jwt, extra) {
  const explicit = extra.consent === false || extra.pair || extra.intent;
  if (!explicit && !(await currentShare())) return { skipped: true };
  const before = await getState();
  let session = await ensureSession(config, jwt);
  if (session.lostLink) {
    await releaseUnlinked(config, session);
    return { linked: false, siteUserId: session.sessionSiteUserId || null };
  }
  await adoptIdentity(session.sessionSiteUserId);
  const resolving = extra.intent === "resolve-push" || extra.intent === "resolve-pull";
  let payload;
  try {
    payload = await exchange(config, session, jwt, extra);
  } catch (error) {
    if (!error.lostLink) throw error;
    await releaseUnlinked(config, session);
    return { linked: false, siteUserId: session.sessionSiteUserId || null };
  }
  if (payload.relogin) {
    await clearSession();
    session = await login(config, jwt, await ensureDeviceId());
    if (session.lostLink) {
      await releaseUnlinked(config, session);
      return { linked: false, siteUserId: session.sessionSiteUserId || null };
    }
    payload = await exchange(config, session, jwt, extra);
  }
  await applyChannel(payload, jwt, resolving);
  if (telegramLeft(before, payload)) await releaseUnlinked(config, session);
  return payload;
}

function telegramLeft(before, payload) {
  if (!before.linked || payload?.linked !== false || before.pendingCode) return false;
  if (before.siteUserId && payload.siteUserId && before.siteUserId !== payload.siteUserId) return false;
  return true;
}

async function releaseUnlinked(config, session) {
  try {
    if (session?.sessionId && session?.sessionKey) await postChannel(config, session, { consent: false });
  } catch (error) {
    if (!error.relogin) console.info("Не удалось стереть токен отвязанного кабинета");
  }
  await clearSession();
  await chrome.storage.local.set({
    shareWithServer: false,
    linked: false,
    jwtHash: null,
    pendingCode: null,
    prefsRevision: null,
    prefsConflict: false,
    prefsDirty: true,
  });
}

async function exchange(config, session, jwt, extra) {
  const message = await buildMessage(jwt, extra);
  try {
    const payload = await postChannel(config, session, message);
    payload.sentPrefs = message.prefs;
    return payload;
  } catch (error) {
    if (!error.relogin) throw error;
    const next = await login(config, jwt, await ensureDeviceId());
    session.sessionId = next.sessionId;
    session.sessionKey = next.sessionKey;
    session.sessionExpires = next.sessionExpires;
    session.channelSeq = next.channelSeq;
    session.sessionSiteUserId = next.sessionSiteUserId;
    session.lostLink = next.lostLink;
    if (next.lostLink) {
      const stop = new Error("Кабинет больше не привязан к Telegram");
      stop.lostLink = true;
      throw stop;
    }
    const retry = await buildMessage(jwt, extra);
    const payload = await postChannel(config, session, retry);
    payload.sentPrefs = retry.prefs;
    return payload;
  }
}

async function buildMessage(jwt, extra) {
  if (extra.consent === false) return { consent: false };
  const state = await getState();
  const message = {};
  if (extra.intent) message.intent = extra.intent;
  const forcePush = extra.intent === "resolve-push";
  const pull = extra.intent === "resolve-pull";
  const wantsSend = forcePush || (state.prefsKnown && !state.prefsConflict && (state.prefsDirty || state.prefsRevision == null));
  if (!pull && wantsSend) {
    message.prefs = await readNotifyPrefs();
    if (state.prefsRevision != null) message.baseRevision = state.prefsRevision;
  } else if (state.prefsRevision != null) {
    message.baseRevision = state.prefsRevision;
  }
  const hash = await digest(jwt);
  if (state.jwtHash && state.jwtHash !== hash) message.jwt = jwt;
  if (extra.pair) message.pair = extra.pair;
  else if (state.pendingCode) message.pairCode = state.pendingCode;
  return message;
}

async function ensureSession(config, jwt) {
  const deviceId = await ensureDeviceId();
  const sub = readSub(jwt);
  const stored = await chrome.storage.session.get(SESSION_KEYS);
  const alive = stored.sessionId && stored.sessionKey && Number(stored.sessionExpires) > Date.now() + 5000;
  if (alive && (!sub || stored.sessionSiteUserId === sub)) return stored;
  return login(config, jwt, deviceId);
}

async function fetchStand(url, options) {
  try {
    return await fetch(url, options);
  } catch (error) {
    if (error instanceof TypeError) throw new Error("Не удалось подключиться к стенду");
    throw error;
  }
}

async function login(config, jwt, deviceId) {
  const sealed = await sealSessionRequest(config.backend.publicKey, jwt);
  const response = await fetchStand(joinUrl(config.backend.baseUrl, config.backend.sessionPath), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      deviceId,
      ephPublic: sealed.ephPublic,
      n: sealed.n,
      c: sealed.c,
    }),
  });
  if (response.status === 401) throw new Error("Кабинет не принял токен");
  if (!response.ok) throw new Error(`Стенд ответил ${response.status}`);
  const envelope = await response.json();
  if (envelope.deviceId !== deviceId || envelope.ephPublic !== sealed.ephPublic) {
    throw new Error("Стенд вернул чужой ответ");
  }
  const payload = await openSessionResponse(sealed.aes, envelope);
  if (!payload.sessionId || !payload.key) throw new Error("Стенд не открыл сессию");
  const prior = await getState();
  const siteUserId = payload.siteUserId || null;
  const sameCabinet = !prior.siteUserId || prior.siteUserId === siteUserId;
  const lostLink = Boolean(prior.linked && !payload.linked && !prior.pendingCode && sameCabinet);
  const session = {
    sessionId: payload.sessionId,
    sessionKey: payload.key,
    sessionExpires: Date.parse(payload.expiresAt),
    channelSeq: 0,
    sessionSiteUserId: siteUserId,
  };
  await chrome.storage.session.set(session);
  if (lostLink) return { ...session, lostLink: true };
  await chrome.storage.local.set({
    siteUserId,
    linked: Boolean(payload.linked),
    jwtHash: await digest(jwt),
  });
  await adoptIdentity(session.sessionSiteUserId);
  return session;
}

async function postChannel(config, session, message) {
  const seq = Number(session.channelSeq || 0) + 1;
  const body = await sealChannel(session.sessionKey, session.sessionId, { ...message, seq });
  const response = await fetchStand(joinUrl(config.backend.baseUrl, config.backend.channelPath), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Session-Id": session.sessionId,
    },
    body: JSON.stringify(body),
  });
  if (response.status === 401) {
    await clearSession();
    const error = new Error("Сессия стенда закончилась");
    error.relogin = true;
    throw error;
  }
  if (!response.ok) throw new Error(`Стенд ответил ${response.status}`);
  const payload = await openChannel(session.sessionKey, session.sessionId, await response.json());
  session.channelSeq = seq;
  await chrome.storage.session.set({ channelSeq: seq });
  return payload;
}

async function clearSession() {
  await chrome.storage.session.remove(SESSION_KEYS);
}

async function reportPresence() {
  try {
    const config = await loadRemoteConfig();
    if (!config.backend.pulsePath) return;
    const granted = await chrome.permissions.contains({ origins: [originPattern(config.backend.baseUrl)] });
    if (!granted) return;
    const installId = await ensureStatsId();
    const version = chrome.runtime.getManifest().version;
    const sealed = await sealToServer(config.backend.publicKey, { installId, version });
    await fetch(joinUrl(config.backend.baseUrl, config.backend.pulsePath), {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ephPublic: sealed.ephPublic, n: sealed.n, c: sealed.c }),
    });
  } catch {
    // Опрос позиций не зависит от обезличенного сигнала.
  }
}

async function ensureStatsId() {
  const stored = await chrome.storage.local.get("statsId");
  const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (typeof stored.statsId === "string" && pattern.test(stored.statsId)) return stored.statsId;
  const statsId = crypto.randomUUID();
  await chrome.storage.local.set({ statsId });
  return statsId;
}

async function ensureDeviceId() {
  const stored = await chrome.storage.local.get("deviceId");
  const devicePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (typeof stored.deviceId === "string" && devicePattern.test(stored.deviceId)) return stored.deviceId;
  const deviceId = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId });
  return deviceId;
}

async function adoptIdentity(siteUserId) {
  if (!siteUserId) return;
  const stored = await chrome.storage.local.get(["prefsOwner", "notifyPrefs", "prefsByUser", "prefsKnown"]);
  const prefsByUser = stored.prefsByUser && typeof stored.prefsByUser === "object" ? { ...stored.prefsByUser } : {};
  if (!stored.prefsOwner) {
    await chrome.storage.local.set({ prefsOwner: siteUserId, prefsKnown: true });
    return;
  }
  if (stored.prefsOwner === siteUserId) return;
  prefsByUser[stored.prefsOwner] = stored.notifyPrefs && typeof stored.notifyPrefs === "object" ? stored.notifyPrefs : {};
  const cached = prefsByUser[siteUserId];
  if (cached && typeof cached === "object") {
    await chrome.storage.local.set({
      prefsByUser,
      prefsOwner: siteUserId,
      notifyPrefs: cached,
      prefsRevision: null,
      prefsDirty: false,
      prefsConflict: false,
      prefsKnown: true,
    });
    return;
  }
  await chrome.storage.local.set({
    prefsByUser,
    prefsOwner: siteUserId,
    notifyPrefs: {},
    prefsRevision: null,
    prefsDirty: false,
    prefsConflict: false,
    prefsKnown: false,
  });
}

async function applyChannel(payload, jwt, resolving) {
  const state = await getState();
  const storedUsers = await chrome.storage.local.get("prefsByUser");
  const prefsByUser = storedUsers.prefsByUser && typeof storedUsers.prefsByUser === "object" ? { ...storedUsers.prefsByUser } : {};
  const patch = {
    siteUserId: payload.siteUserId || null,
    linked: Boolean(payload.linked),
  };
  const settings = payload.settings || {};
  const holdConflict = state.prefsConflict && !resolving && !settings.conflict;
  if (settings.conflict) {
    patch.prefsConflict = true;
  } else if (!holdConflict && settings.prefs && typeof settings.prefs === "object") {
    const local = await readNotifyPrefs();
    const editedDuringSend = payload.sentPrefs && !knownEqual(local, payload.sentPrefs);
    patch.prefsRevision = settings.revision ?? null;
    patch.prefsConflict = false;
    patch.prefsKnown = true;
    if (editedDuringSend) {
      patch.prefsDirty = true;
    } else {
      patch.notifyPrefs = settings.prefs;
      patch.prefsDirty = false;
      if (payload.siteUserId) prefsByUser[payload.siteUserId] = settings.prefs;
      patch.prefsByUser = prefsByUser;
    }
  }
  const hash = await digest(jwt);
  const sentJwt = Boolean(state.jwtHash && state.jwtHash !== hash);
  if (payload.tokenAccepted === false) {
    patch.lastError = "Кабинет не принял новый токен.";
  } else if (!payload.relogin && (payload.tokenAccepted || !sentJwt)) {
    patch.jwtHash = hash;
  }
  if (payload.pair) {
    if (payload.pair.missing) {
      patch.pendingCode = null;
      patch.lastError = "Код привязки не найден";
    } else if (payload.pair.deepLink && payload.pair.code) {
      patch.pendingCode = payload.pair.code;
      if (!patch.lastError) patch.lastError = null;
    } else if (payload.pair.linked) {
      patch.linked = true;
      patch.pendingCode = null;
      patch.lastError = null;
    } else if (payload.pair.expired) {
      patch.pendingCode = null;
      patch.lastError = "Срок кода истёк. Запросите ссылку снова.";
    } else if (payload.pair.used) {
      patch.pendingCode = null;
      patch.lastError = "Привязка отменена.";
    }
  } else if (payload.tokenAccepted !== false && !patch.lastError) {
    patch.lastError = null;
  }
  await chrome.storage.local.set(patch);
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

async function readNotifyPrefs() {
  const stored = await chrome.storage.local.get("notifyPrefs");
  const prefs = stored.notifyPrefs;
  return prefs && typeof prefs === "object" ? prefs : {};
}

async function browserNotificationsGranted() {
  const level = await chrome.notifications.getPermissionLevel();
  return level === "granted";
}

async function markUnseen(count) {
  const state = await getState();
  const next = Math.min(999, (state.unseenChanges || 0) + count);
  await chrome.storage.local.set({ unseenChanges: next });
  await chrome.action.setBadgeBackgroundColor({ color: "#c24141" });
  await chrome.action.setBadgeText({ text: next > 99 ? "99+" : String(next) });
  console.info(`Баннеры браузера выключены, на значке ${next}`);
}

async function clearBadge() {
  await chrome.storage.local.set({ unseenChanges: 0 });
  await chrome.action.setBadgeText({ text: "" });
}

async function notifyPositions(events) {
  const text = renderMessages(events).join("\n\n");
  await chrome.notifications.create(`wl-pos-${Date.now()}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "Позиции Whitelist",
    message: text.slice(0, 500) || "Позиции изменились",
  });
}

function knownEqual(left, right) {
  return NOTIFY_OPTIONS.every((option) => (left?.[option.id] !== false) === (right?.[option.id] !== false));
}

async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  const buffer = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buffer)].map((item) => item.toString(16).padStart(2, "0")).join("");
}
