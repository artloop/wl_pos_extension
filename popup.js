import { accessOrigins, loadRemoteConfig } from "./config.js";

const statusNode = document.querySelector("#status");
const versionNode = document.querySelector("#version");
const backendNode = document.querySelector("#backend");
const updateNode = document.querySelector("#update");
const grantButton = document.querySelector("#grant");
const linkButton = document.querySelector("#link");

async function send(message) {
  return chrome.runtime.sendMessage(message);
}

function setStatus(text) {
  statusNode.textContent = text;
}

async function render() {
  const state = await send({ type: "getStatus" });
  versionNode.textContent = `Версия ${state.version}`;
  backendNode.textContent = state.backend ? `Стенд: ${state.backend}` : "Адрес стенда ещё не получен";
  if (state.update) {
    updateNode.hidden = false;
    const notes = state.update.notes ? ` ${state.update.notes}` : "";
    const link = state.update.downloadUrl ? ` ${state.update.downloadUrl}` : "";
    updateNode.textContent = `Доступна версия ${state.update.latestVersion}.${notes}${link}`;
  } else {
    updateNode.hidden = true;
  }
  grantButton.disabled = !state.backend || state.permissionGranted;
  grantButton.classList.toggle("secondary", state.permissionGranted);
  if (state.configError) {
    setStatus(state.configError);
    linkButton.disabled = true;
    return;
  }
  if (!state.permissionGranted) {
    setStatus("Разрешите доступ к кабинету и стенду.");
    linkButton.disabled = true;
    return;
  }
  linkButton.disabled = false;
  if (state.pending) {
    setStatus("Подтвердите привязку в Telegram.");
    return;
  }
  if (state.linked) {
    setStatus(state.siteUserId ? `Telegram подключён, кабинет ${state.siteUserId}.` : "Telegram подключён.");
  } else if (state.lastError) {
    setStatus(state.lastError);
  } else {
    setStatus("Локальные уведомления включены, пока Telegram не подключён.");
  }
}

grantButton.addEventListener("click", async () => {
  grantButton.disabled = true;
  try {
    const config = await loadRemoteConfig();
    const granted = await chrome.permissions.request({ origins: accessOrigins(config) });
    if (!granted) {
      setStatus("Доступ не выдан.");
    } else {
      await send({ type: "poll" });
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Не удалось запросить доступ");
  }
  await render();
});

linkButton.addEventListener("click", async () => {
  linkButton.disabled = true;
  setStatus("Открываю Telegram…");
  try {
    const config = await loadRemoteConfig();
    const jwt = await readJwt(config.whitelist.positionUrl);
    if (!jwt) {
      setStatus("Cookie jwt не найдена. Войдите на сайт.");
      return;
    }
    const result = await send({ type: "link", jwt });
    if (result?.error) {
      setStatus(result.error);
      return;
    }
    if (result?.pending) {
      setStatus("Подтвердите привязку в Telegram.");
      return;
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Не удалось открыть Telegram");
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

render();
