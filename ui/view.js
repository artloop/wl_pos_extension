import { accessOrigins, loadRemoteConfig } from "../src/config.js";
import { isActiveInstrument, isDeskInstrument } from "../src/diff.js";
import {
  finite,
  formatLots,
  formatPlain,
  isShort,
  lotsOf,
  money,
  orderSide,
  ordersOf,
  sortOrders,
  visibleHistory,
} from "../src/history.js";
import { NOTIFY_OPTIONS } from "../src/notify-prefs.js";

const MARKETS = [
  ["stock", "Акции"],
  ["futures", "Фьючерсы"],
  ["currency", "Валюта"],
];

const PRIVACY_OFF =
  "Токен кабинета и настройки остаются в этом браузере. На сервер уходит только версия и случайный номер установки, без кабинета и Telegram.";
const PRIVACY_ON =
  "На сервере лежат зашифрованный токен, зашифрованные идентификаторы кабинета и Telegram и настройки оповещений. Позиции и заявки в базу не записываются. Сообщение приходит только вам.";
const BANNERS_OFF = "Баннеры браузера выключены. Изменения копятся числом на значке расширения.";

const ICONS = {
  up: "M4 12l1.41 1.41L11 7.83V20h2V7.83l5.59 5.58L20 12l-8-8-8 8z",
  down: "M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.59-5.58L4 12l8 8 8-8z",
  plus: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
  minus: "M19 13H5v-2h14v2z",
  list: "M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z",
  chevron: "M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z",
  lots: "M4 8h16v3H4zm0 5h16v3H4z",
  result: "M3 17l5.2-5.2 3.3 3.3L19 7.5l1.4 1.4-9 9-3.3-3.3L4.4 18.4z",
  session: "M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V9h14v11z",
  fee: "M19 3H5a2 2 0 0 0-2 2v14l4-2 4 2 4-2 4 2V5a2 2 0 0 0-2-2z",
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
const openDeskButton = document.querySelector("#open-desk");
const historyNode = document.querySelector("#history");
const historyToggle = document.querySelector("#history-toggle");
const historyList = document.querySelector("#history-list");
const historyCount = document.querySelector("#history-count");

let updateUrl = "";
let notifyPrefs = {};
let prefsWrite = Promise.resolve();
let viewState = { shareWithServer: false, linked: false, pending: false };
let shareInput = null;
let shareNote = null;
let layout = "compact";
let historyOpen = false;
let seenSnapshotAt = null;
let rawHistory = [];

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
  paintHistory();
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
    note.textContent = layout === "desk" ? "Нет позиций, заявок и комиссии" : "Нет позиций и заявок";
    positionsNode.append(note);
    return;
  }
  if (layout === "desk") positionsNode.append(columnHead());
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

function columnHead() {
  const head = document.createElement("div");
  head.className = "columns";
  const labels = [
    ["", ""],
    ["Инструмент", ""],
    ["lots", "Объём"],
    ["result", "Открытый результат"],
    ["session", "За сессию"],
    ["fee", "Комиссия"],
    ["list", "Заявки"],
    ["", ""],
  ];
  for (const [name, label] of labels) {
    const cell = document.createElement("span");
    if (ICONS[name]) {
      cell.append(icon(name));
      cell.title = label;
      cell.setAttribute("aria-label", label);
    } else {
      cell.textContent = name;
    }
    head.append(cell);
  }
  return head;
}

function marketGroups(snapshot) {
  const groups = [];
  for (const [market, title] of MARKETS) {
    const items = Array.isArray(snapshot[market]) ? snapshot[market] : [];
    const visible = items.filter((item) => (layout === "desk" ? isDeskInstrument(item) : isActiveInstrument(item)));
    if (visible.length) groups.push([title, visible]);
  }
  return groups;
}

function renderRow(item) {
  const orders = sortOrders(ordersOf(item));
  const lots = lotsOf(item.position);
  const pnl = money(item.openedFinancialResult);
  const session = money(item.expectedFinancialResult);
  const commission = money(item.commission);
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
  } else if (layout === "desk" && finite(item.position) === 0) {
    qty.textContent = "0";
    qty.setAttribute("aria-label", "Объём 0");
  } else if (layout !== "desk") {
    const shownCount = orders.length > 0 ? orders.length : finite(item.orderCount);
    qty.append(icon("list"));
    const countText = document.createElement("span");
    countText.textContent = shownCount == null ? "" : String(shownCount);
    qty.append(countText);
    if (shownCount != null) qty.setAttribute("aria-label", `Заявки ${shownCount}`);
  }
  const cells = [edge, name, qty, figure(pnl, "openedFinancialResult")];
  if (layout === "desk") {
    cells.push(figure(session, "expectedFinancialResult"), figure(commission, "commission"), orderFigure(item, orders));
  }
  const chevron = details ? icon("chevron") : document.createElement("span");
  if (details) chevron.classList.add("chevron");
  cells.push(chevron);
  summary.append(...cells);
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

function figure(value, field) {
  const node = document.createElement("span");
  node.className = "pnl";
  if (!value) return node;
  node.classList.add(value.negative ? "down" : "up");
  node.textContent = value.text;
  const labels = {
    openedFinancialResult: "Открытый результат",
    expectedFinancialResult: "За сессию",
    commission: "Комиссия",
  };
  node.setAttribute("aria-label", `${labels[field]} ${value.text}`);
  return node;
}

function orderFigure(item, orders) {
  const node = document.createElement("span");
  node.className = "qty";
  const count = orders.length > 0 ? orders.length : finite(item.orderCount);
  if (count == null || count === 0) return node;
  node.append(icon("list"));
  const text = document.createElement("span");
  text.textContent = String(count);
  node.append(text);
  node.setAttribute("aria-label", `Заявки ${count}`);
  return node;
}

function renderDetails(item, orders) {
  const box = document.createElement("div");
  box.className = "details";
  if (layout !== "desk") {
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

function shown(value) {
  return value == null || value === "" ? "—" : String(value);
}

function formatClock(timestamp, withSeconds = false) {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  if (!withSeconds) return `${hours}:${minutes}`;
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function renderHistory(entries, storedCount) {
  if (!historyNode) return;
  const list = Array.isArray(entries) ? entries : [];
  historyCount.textContent = String(list.length);
  historyList.replaceChildren();
  if (!list.length) {
    const note = document.createElement("p");
    note.className = "positions-note";
    note.textContent = storedCount ? "По выбранным оповещениям изменений нет" : "Изменений пока нет";
    historyList.append(note);
    return;
  }
  for (const entry of list) historyList.append(renderHistoryRow(entry));
}

function renderHistoryRow(entry) {
  const row = document.createElement("div");
  row.className = "history-row";
  const time = document.createElement("time");
  time.className = "history-time";
  time.dateTime = new Date(entry.at).toISOString();
  time.textContent = formatClock(entry.at, true);
  const tool = document.createElement("strong");
  tool.className = "tool";
  tool.textContent = entry.tool || "";
  const marks = document.createElement("span");
  marks.className = "marks";
  for (const mark of entry.marks || []) {
    const item = document.createElement("span");
    item.className = ["mark", mark.kind, mark.tone].filter(Boolean).join(" ");
    if (mark.label) item.setAttribute("aria-label", mark.label);
    const parts = Array.isArray(mark.icons) ? mark.icons : mark.icon ? [{ icon: mark.icon }] : [];
    for (const part of parts) {
      if (!ICONS[part.icon]) continue;
      const glyph = icon(part.icon);
      if (part.tone) glyph.classList.add(part.tone);
      if (part.label) {
        const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        title.textContent = part.label;
        glyph.prepend(title);
      }
      if (part.badge) {
        const badge = document.createElement("span");
        badge.className = "side";
        badge.append(glyph);
        item.append(badge);
      } else {
        item.append(glyph);
      }
    }
    if (mark.value) {
      const value = document.createElement("span");
      value.textContent = mark.value;
      item.append(value);
    }
    marks.append(item);
  }
  row.append(time, tool, marks);
  return row;
}

function paintHistory() {
  if (layout !== "desk") return;
  renderHistory(visibleHistory(rawHistory, notifyPrefs), rawHistory.length);
}

async function loadHistory() {
  if (layout !== "desk") return;
  const result = await send({ type: "getHistory" });
  rawHistory = Array.isArray(result?.history) ? result.history : [];
  paintHistory();
}

function watchPoll() {
  let closed = false;
  const connect = () => {
    if (closed) return;
    const port = chrome.runtime.connect({ name: "positions" });
    port.onDisconnect.addListener(() => {
      if (!closed) setTimeout(connect, 200);
    });
  };
  window.addEventListener("pagehide", () => {
    closed = true;
  });
  connect();
}

async function paintStored() {
  const state = await send({ type: "getStatus" });
  const canShow = paintChrome(state);
  if (!canShow) {
    hidePositions();
    return;
  }
  renderPositions(state.lastSnapshot, state.snapshotAt);
  if (state.snapshotAt !== seenSnapshotAt) {
    seenSnapshotAt = state.snapshotAt;
    await loadHistory();
  }
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
  seenSnapshotAt = fresh.snapshotAt;
  await loadHistory();
  await send({ type: "seen" });
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

export async function bindPage(options = {}) {
  layout = options.layout === "desk" ? "desk" : "compact";
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
  prefsPush.addEventListener("click", () => resolveConflict("push"));
  prefsPull.addEventListener("click", () => resolveConflict("pull"));
  if (openDeskButton) {
    openDeskButton.addEventListener("click", async () => {
      const result = await send({ type: "openDesk" });
      if (!result?.error) window.close();
    });
  }
  if (historyToggle) {
    historyToggle.addEventListener("click", () => {
      historyOpen = !historyOpen;
      historyList.hidden = !historyOpen;
      historyToggle.setAttribute("aria-expanded", String(historyOpen));
      historyToggle.querySelector(".chevron")?.classList.toggle("open", historyOpen);
    });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.notifyPrefs) buildSettings().then(() => paintHistory());
    if (changes.prefsConflict || changes.shareWithServer) {
      const conflict = changes.prefsConflict ? changes.prefsConflict.newValue : viewState.prefsConflict;
      const share = changes.shareWithServer ? changes.shareWithServer.newValue : viewState.shareWithServer;
      conflictPanel.hidden = !conflict || !share;
    }
    if (changes.lastSnapshot || changes.snapshotAt || changes.lastError) paintStored();
  });
  watchPoll();
  await buildSettings();
  await render();
}
