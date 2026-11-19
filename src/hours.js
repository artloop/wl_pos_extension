const QUIET_ZONE = "Europe/Moscow";

export function marketClosed(date = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: QUIET_ZONE,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(date)
  );
  return hour % 24 < 6;
}
