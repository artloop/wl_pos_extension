export const NOTIFY_OPTIONS = [
  { id: "opened", label: "Появление позиции", group: "Позиция" },
  { id: "closed", label: "Исчезновение позиции", group: "Позиция" },
  { id: "type", label: "Направление", group: "Позиция" },
  { id: "position", label: "Объём", group: "Позиция" },
  { id: "expectedFinancialResult", label: "Результат за сессию", group: "Деньги" },
  { id: "openedFinancialResult", label: "Открытый результат", group: "Деньги" },
  { id: "commission", label: "Комиссия", group: "Деньги" },
  { id: "orders", label: "Заявки", group: "Заявки" },
];

const NOTIFY_DEFAULTS = Object.fromEntries(NOTIFY_OPTIONS.map((option) => [option.id, true]));

function allowed(prefs) {
  const allow = { ...NOTIFY_DEFAULTS };
  if (!prefs || typeof prefs !== "object") return allow;
  for (const option of NOTIFY_OPTIONS) {
    if (option.id in prefs) allow[option.id] = prefs[option.id] !== false;
  }
  return allow;
}

export function notifyEnabled(prefs, id) {
  return allowed(prefs)[id] !== false;
}

export function filterEvents(events, prefs) {
  const allow = allowed(prefs);
  const visible = [];
  for (const event of events || []) {
    if (event.kind === "opened" || event.kind === "closed") {
      if (allow[event.kind]) visible.push(event);
      continue;
    }
    if (event.kind !== "changed") continue;
    const changes = (event.changes || []).filter((name) => allow[name] !== false);
    if (!changes.length) continue;
    if (changes.length === event.changes.length) visible.push(event);
    else visible.push({ ...event, changes });
  }
  return visible;
}
