import { accessOrigins, loadRemoteConfig } from "./config.js";
import { isActiveInstrument } from "./diff.js";
import { NOTIFY_OPTIONS } from "./notify-prefs.js";

const MARKETS = [
  ["stock", "Акции"],
  ["futures", "Фьючерсы"],
  ["currency", "Валюта"],
];

const BUY = new Set(["buy", "long", "b", "покупка"]);
const SELL = new Set(["sell", "short", "s", "продажа"]);

const PRIVACY_OFF = "Токен кабинета и настройки остаются в этом браузере и на сервер не отправляются.";
const PRIVACY_ON =
  "На сервере лежат зашифрованный токен кабинета и настройки оповещений. Торговую статистику и историю сделок мы не храним. Пока включён Telegram, нужен только последний снимок позиций, чтобы заметить изменение. Сообщение приходит только вам.";
const BANNERS_OFF = "Баннеры браузера выключены. Изменения копятся числом на значке расширения.";

const ICONS = {
  up: "M4 12l1.41 1.41L11 7.83V20h2V7.83l5.59 5.58L20 12l-8-8-8 8z",
  down: "M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.59-5.58L4 12l8 8 8-8z",
  list: "M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z",
  chevron: "M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z",
};

const privacyButton = document.querySelector("#privacy-status");
const privacyTip = document.querySelector("#privacy-tip");
const privacyInfoNode = document.querySelector("#privacy-info");
const alertButton = document.querySelector("#alert");
const alertTip = document.querySelector("#alert-tip");
const bannersButton = document.querySelector("#banners");
const bannersTip = document.querySelector("#banners-tip");
const versionNode = document.querySelector("#version");
const backendNode = document.querySelector("#backend");
const linkStateNode = document.querySelector("#link-state");
const bannerStateNode = document.querySelector("#banner-state");
const updateButton = document.querySelector("#update");
const updateTip = document.querySelector("#update-tip");
const positionsNode = document.querySelector("#positions");
const settingsPanel = document.querySelector("#settings-panel");
const conflictPanel = document.querySelector("#prefs-conflict");
const prefsPush = document.querySelector("#prefs-push");
const prefsPull = document.querySelector("#prefs-pull");
const infoPanel = document.querySelector("#info-panel");
const settingsButton = document.querySelector("#settings");
const infoButton = document.querySelector("#info");
const grantButton = document.querySelector("#grant");
const linkButton = document.querySelector("#link");
const linkTip = document.querySelector("#link-tip");

let updateUrl = "";

async function send(message) {
  return chrome.runtime.sendMessage(message);
}

function setTip(button, tipNode, text) {
  tipNode.textContent = text;
  button.setAttribute("aria-label", text);
}

function setAlert(text) {
  const message = text || "";
  alertButton.hidden = !message;
  alertTip.textContent = message;
  if (message) alertButton.setAttribute("aria-label", message);
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

function privacyText(state) {
  if (state.shareWithServer || state.linked || state.pending) return PRIVACY_ON;
  return PRIVACY_OFF;
}

function paintChrome(state) {
  viewState = state;
  const privacy = privacyText(state);
  privacyInfoNode.textContent = privacy;
  setTip(privacyButton, privacyTip, privacy);
  privacyButton.classList.toggle("on", Boolean(state.shareWithServer || state.linked || state.pending));
  privacyButton.classList.remove("busy");
  syncShareControl();
  versionNode.textContent = `Версия ${state.version}`;
  backendNode.hidden = Boolean(state.backend);
  backendNode.textContent = state.backend ? "" : "Конфигурация стенда ещё не получена";
  linkStateNode.textContent = telegramLine(state);
  bannerStateNode.textContent = state.notificationsDenied
    ? "Баннеры браузера выключены, изменения копятся на значке."
    : "Баннеры браузера включены.";
  bannersButton.hidden = !state.notificationsDenied;
  if (state.notificationsDenied) setTip(bannersButton, bannersTip, BANNERS_OFF);
  linkButton.classList.remove("busy");
  setTip(linkButton, linkTip, linkTipText(state));
  linkButton.classList.toggle("on", Boolean(state.linked));
  if (state.update) {
    updateButton.hidden = false;
    const notes = state.update.notes ? ` ${state.update.notes}` : "";
    setTip(updateButton, updateTip, `Доступна версия ${state.update.latestVersion}.${notes}`);
    updateUrl = state.update.downloadUrl || "";
  } else {
    updateButton.hidden = true;
    updateUrl = "";
  }
  grantButton.hidden = !state.backend || state.permissionGranted;
  grantButton.disabled = false;
  conflictPanel.hidden =
    !state.prefsConflict || !state.shareWithServer || !state.permissionGranted || Boolean(state.configError);
  if (state.configError) {
    setAlert(state.configError);
    linkButton.disabled = true;
    return false;
  }
  if (!state.permissionGranted) {
    setAlert("");
    linkButton.disabled = true;
    return false;
  }
  linkButton.disabled = false;
  setAlert(state.lastError || "");
  return true;
}

function telegramLine(state) {
  if (state.pending) return "Telegram: ожидание подтверждения.";
  if (state.linked) {
    return state.siteUserId ? `Telegram подключён, кабинет ${state.siteUserId}.` : "Telegram подключён.";
  }
  return "Telegram не подключён. Оповещения приходят в браузер.";
}

function linkTipText(state) {
  if (state.pending) return "Подтвердите привязку в Telegram.";
  if (state.linked) {
    const who = state.siteUserId ? `, кабинет ${state.siteUserId}` : "";
    return `Telegram подключён${who}. Нажмите, чтобы привязать заново.`;
  }
  return "Локальные уведомления включены. Следить в Telegram — перенести оповещения в бот.";
}

function togglePanel(button, panel) {
  const willOpen = panel.hidden;
  settingsPanel.hidden = true;
  infoPanel.hidden = true;
  settingsButton.setAttribute("aria-expanded", "false");
  infoButton.setAttribute("aria-expanded", "false");
  if (willOpen) {
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
  }
}

let notifyPrefs = {};
let prefsWrite = Promise.resolve();
let viewState = { shareWithServer: false, linked: false, pending: false };
let shareInput = null;
let shareNote = null;

function syncShareControl() {
  if (!shareInput || !shareNote) return;
  const locked = Boolean(viewState.linked || viewState.pending || viewState.shareLocked);
  shareInput.checked = Boolean(viewState.shareWithServer || locked);
  shareInput.disabled = locked;
  shareNote.textContent = privacyText(viewState);
}

async function saveShare(enabled) {
  if (!shareInput) return;
  const locked = Boolean(viewState.linked || viewState.pending || viewState.shareLocked);
  if (!enabled && locked) {
    shareInput.checked = true;
    return;
  }
  shareInput.disabled = true;
  let result = null;
  try {
    result = await send({ type: "setShare", enabled });
  } catch (error) {
    result = { error: error instanceof Error ? error.message : "Не удалось изменить сохранение на сервере" };
  }
  if (result?.locked || (!enabled && result?.error)) shareInput.checked = true;
  await render();
  if (result?.error) setAlert(result.error);
}

async function buildSettings() {
  const stored = await chrome.storage.local.get("notifyPrefs");
  const prefs = stored.notifyPrefs && typeof stored.notifyPrefs === "object" ? stored.notifyPrefs : {};
  notifyPrefs = { ...prefs };
  const groups = [];
  for (const option of NOTIFY_OPTIONS) {
    let group = groups.find((item) => item.name === option.group);
    if (!group) {
      group = { name: option.group, options: [] };
      groups.push(group);
    }
    group.options.push(option);
  }
  settingsPanel.replaceChildren();
  const shareTitle = document.createElement("p");
  shareTitle.className = "panel-title";
  shareTitle.textContent = "Сервер";
  const shareLabel = document.createElement("label");
  shareLabel.className = "share-toggle";
  shareInput = document.createElement("input");
  shareInput.type = "checkbox";
  shareInput.addEventListener("change", () => saveShare(shareInput.checked));
  const shareText = document.createElement("span");
  shareText.textContent = "Сохранять настройки на сервере";
  shareLabel.append(shareInput, shareText);
  shareNote = document.createElement("p");
  shareNote.className = "privacy";
  settingsPanel.append(shareTitle, shareLabel, shareNote);
  syncShareControl();
  for (const group of groups) {
    const title = document.createElement("p");
    title.className = "panel-title";
    title.textContent = group.name;
    const list = document.createElement("div");
    list.className = "checks";
    for (const option of group.options) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = notifyPrefs[option.id] !== false;
      input.addEventListener("change", () => savePref(option.id, input.checked));
      const text = document.createElement("span");
      text.textContent = option.label;
      label.append(input, text);
      list.append(label);
    }
    settingsPanel.append(title, list);
  }
}

function savePref(id, enabled) {
  notifyPrefs[id] = enabled;
  const snapshot = { ...notifyPrefs };
  prefsWrite = prefsWrite.then(async () => {
    await chrome.storage.local.set({ notifyPrefs: snapshot, prefsDirty: true, prefsKnown: true });
    await send({ type: "prefsChanged" });
  });
}

function hidePositions() {
  positionsNode.hidden = true;
  positionsNode.replaceChildren();
}

function renderPositions(snapshot, snapshotAt) {
  if (!snapshot) {
    hidePositions();
    return;
  }
  positionsNode.replaceChildren();
  positionsNode.hidden = false;
  const meta = document.createElement("p");
  meta.className = "positions-meta";
  meta.textContent = snapshotAt ? `Обновлено в ${formatClock(snapshotAt)}` : "Обновлено";
  positionsNode.append(meta);
  const groups = marketGroups(snapshot);
  if (!groups.length) {
    const note = document.createElement("p");
    note.className = "positions-note";
    note.textContent = "Нет позиций и заявок";
    positionsNode.append(note);
    return;
  }
  for (const [title, items] of groups) {
    const section = document.createElement("section");
    const heading = document.createElement("h2");
    heading.append(document.createTextNode(title));
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(items.length);
    heading.append(count);
    const rows = document.createElement("div");
    rows.className = "rows";
    for (const item of items) rows.append(renderRow(item));
    section.append(heading, rows);
    positionsNode.append(section);
  }
}

function marketGroups(snapshot) {
  const groups = [];
  for (const [market, title] of MARKETS) {
    const items = Array.isArray(snapshot[market]) ? snapshot[market] : [];
    const visible = items.filter(isActiveInstrument);
    if (visible.length) groups.push([title, visible]);
  }
  return groups;
}

function renderRow(item) {
  const orders = sortOrders(ordersOf(item));
  const lots = lotsOf(item.position);
  const pnl = money(item.openedFinancialResult);
  const details = renderDetails(item, orders);
  const article = document.createElement("article");
  const short = lots != null && isShort(item);
  article.className = lots == null ? "row flat" : short ? "row short" : "row long";

  const summary = document.createElement(details ? "button" : "div");
  summary.className = "summary";
  if (details) {
    summary.type = "button";
    summary.setAttribute("aria-expanded", "false");
  }

  const edge = document.createElement("span");
  edge.className = "edge";
  const name = document.createElement("strong");
  name.className = "tool";
  name.textContent = item.tool;
  const qty = document.createElement("span");
  qty.className = "qty";
  if (lots != null) {
    qty.classList.add(short ? "down" : "up");
    qty.append(icon(short ? "down" : "up"));
    const lotsText = document.createElement("span");
    lotsText.textContent = formatLots(lots);
    qty.append(lotsText);
    qty.setAttribute("aria-label", `${short ? "Короткая" : "Длинная"} ${formatLots(lots)}`);
  } else {
    const shownCount = orders.length > 0 ? orders.length : finite(item.orderCount);
    qty.append(icon("list"));
    const countText = document.createElement("span");
    countText.textContent = shownCount == null ? "" : String(shownCount);
    qty.append(countText);
    if (shownCount != null) qty.setAttribute("aria-label", `Заявки ${shownCount}`);
  }
  const pnlNode = document.createElement("span");
  pnlNode.className = "pnl";
  if (pnl) {
    pnlNode.classList.add(pnl.negative ? "down" : "up");
    pnlNode.textContent = pnl.text;
  }
  const chevron = details ? icon("chevron") : document.createElement("span");
  if (details) chevron.classList.add("chevron");
  summary.append(edge, name, qty, pnlNode, chevron);
  article.append(summary);
  if (details) {
    details.hidden = true;
    summary.addEventListener("click", () => {
      const open = details.hidden;
      details.hidden = !open;
      summary.setAttribute("aria-expanded", String(open));
      chevron.classList.toggle("open", open);
    });
    article.append(details);
  }
  return article;
}

function renderDetails(item, orders) {
  const box = document.createElement("div");
  box.className = "details";
  const expected = money(item.expectedFinancialResult);
  const commission = money(item.commission);
  const moneyBits = [];
  if (expected) moneyBits.push(`За сессию ${expected.text}`);
  if (commission) moneyBits.push(`комиссия ${commission.text}`);
  if (moneyBits.length) {
    const line = document.createElement("p");
    line.textContent = moneyBits.join(" · ");
    box.append(line);
  }
  const count = finite(item.orderCount);
  if (count != null && count > orders.length) {
    const note = document.createElement("p");
    note.textContent = `Всего заявок ${count}`;
    box.append(note);
  }
  for (const order of orders) {
    const line = document.createElement("p");
    line.className = "order";
    const side = orderSide(order.direction);
    const direction = document.createElement("span");
    direction.className = side === "buy" ? "side up" : side === "sell" ? "side down" : "side";
    if (side === "buy" || side === "sell") direction.append(icon(side === "buy" ? "up" : "down"));
    else direction.textContent = shown(order.direction);
    line.append(direction);
    const bits = [];
    const orderLots = formatLots(order.lots);
    const price = formatPlain(order.price);
    if (orderLots) bits.push(orderLots);
    if (price) bits.push(`@ ${price}`);
    if (bits.length) line.append(document.createTextNode(bits.join(" ")));
    box.append(line);
  }
  return box.childNodes.length ? box : null;
}

function ordersOf(item) {
  return Array.isArray(item.orders) ? item.orders.filter((order) => order && typeof order === "object") : [];
}

function sortOrders(orders) {
  return orders
    .map((order, index) => ({ order, index }))
    .sort((left, right) => {
      const leftPrice = finite(left.order.price);
      const rightPrice = finite(right.order.price);
      if (leftPrice == null && rightPrice == null) return left.index - right.index;
      if (leftPrice == null) return 1;
      if (rightPrice == null) return -1;
      if (leftPrice !== rightPrice) return leftPrice - rightPrice;
      return left.index - right.index;
    })
    .map((entry) => entry.order);
}

function orderSide(direction) {
  const value = String(direction ?? "").trim().toLowerCase();
  if (BUY.has(value)) return "buy";
  if (SELL.has(value)) return "sell";
  return null;
}

function lotsOf(value) {
  const n = finite(value);
  if (n == null || n === 0) return null;
  return Math.abs(n);
}

function isShort(item) {
  const type = String(item.type || "").toLowerCase();
  if (type === "short") return true;
  if (type === "long") return false;
  const n = finite(item.position);
  return n != null && n < 0;
}

function money(value) {
  const n = finite(value);
  if (n == null || n === 0) return null;
  const text = `${new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ₽`;
  return { text, negative: n < 0 };
}

function formatLots(value) {
  const n = finite(value);
  if (n == null) return null;
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(Math.abs(n));
}

function formatPlain(value) {
  const n = finite(value);
  if (n == null) return null;
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 4 }).format(n);
}

function finite(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function shown(value) {
  return value == null || value === "" ? "—" : String(value);
}

function formatClock(timestamp) {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

async function render() {
  privacyButton.classList.add("busy");
  const state = await send({ type: "getStatus" });
  const canShow = paintChrome(state);
  if (!canShow) {
    hidePositions();
    await send({ type: "seen" });
    return;
  }
  renderPositions(state.lastSnapshot, state.snapshotAt);
  privacyButton.classList.add("busy");
  await send({ type: "poll" });
  const fresh = await send({ type: "getStatus" });
  if (!paintChrome(fresh)) {
    hidePositions();
    await send({ type: "seen" });
    return;
  }
  renderPositions(fresh.lastSnapshot, fresh.snapshotAt);
  await send({ type: "seen" });
}

settingsButton.addEventListener("click", () => togglePanel(settingsButton, settingsPanel));
infoButton.addEventListener("click", () => togglePanel(infoButton, infoPanel));

grantButton.addEventListener("click", async () => {
  grantButton.disabled = true;
  let failure = "";
  try {
    const config = await loadRemoteConfig();
    const granted = await chrome.permissions.request({ origins: accessOrigins(config) });
    if (!granted) failure = "Доступ не выдан.";
  } catch (error) {
    failure = error instanceof Error ? error.message : "Не удалось запросить доступ";
  }
  await render();
  if (failure) setAlert(failure);
});

updateButton.addEventListener("click", () => {
  if (updateUrl) chrome.tabs.create({ url: updateUrl });
});

linkButton.addEventListener("click", async () => {
  linkButton.disabled = true;
  linkButton.classList.add("busy");
  setTip(linkButton, linkTip, "Открываю Telegram…");
  try {
    const config = await loadRemoteConfig();
    const jwt = await readJwt(config.whitelist.positionUrl);
    if (!jwt) {
      linkButton.classList.remove("busy");
      setTip(linkButton, linkTip, linkTipText(viewState));
      setAlert("Cookie jwt не найдена. Войдите на сайт.");
      linkButton.disabled = false;
      return;
    }
    const result = await send({ type: "link", jwt });
    if (result?.error) {
      linkButton.classList.remove("busy");
      setTip(linkButton, linkTip, linkTipText(viewState));
      setAlert(result.error);
      linkButton.disabled = false;
      return;
    }
  } catch (error) {
    linkButton.classList.remove("busy");
    setTip(linkButton, linkTip, linkTipText(viewState));
    setAlert(error instanceof Error ? error.message : "Не удалось открыть Telegram");
    linkButton.disabled = false;
    return;
  }
  await render();
});

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

async function resolveConflict(choice) {
  prefsPush.disabled = true;
  prefsPull.disabled = true;
  let failure = "";
  try {
    const result = await send({ type: "resolvePrefs", choice });
    if (result?.error) failure = result.error;
  } catch (error) {
    failure = error instanceof Error ? error.message : "Не удалось синхронизировать настройки";
  }
  prefsPush.disabled = false;
  prefsPull.disabled = false;
  await render();
  if (failure) setAlert(failure);
}

prefsPush.addEventListener("click", () => resolveConflict("push"));
prefsPull.addEventListener("click", () => resolveConflict("pull"));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.notifyPrefs) buildSettings();
  if (changes.prefsConflict || changes.shareWithServer) {
    const conflict = changes.prefsConflict ? changes.prefsConflict.newValue : viewState.prefsConflict;
    const share = changes.shareWithServer ? changes.shareWithServer.newValue : viewState.shareWithServer;
    conflictPanel.hidden = !conflict || !share;
  }
});

await buildSettings();
render();

