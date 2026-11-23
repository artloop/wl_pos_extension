import assert from "node:assert/strict";
import test from "node:test";
import { accessDeniedMessage, accessOrigins, aniscanOrigins, signInPrompts } from "./config.js";

const config = {
  backend: { baseUrl: "https://wl.artloop.ru" },
  whitelist: { positionUrl: "https://api.moex.whitelist.capital/api/v1/user/position" },
};

test("position access does not include AniScan", () => {
  const origins = accessOrigins(config);
  assert.deepEqual(origins, [
    "https://wl.artloop.ru/*",
    "https://api.moex.whitelist.capital/*",
    "https://moex.whitelist.capital/*",
  ]);
  for (const origin of aniscanOrigins()) assert.equal(origins.includes(origin), false);
});

test("access message names only the services that are missing", () => {
  assert.equal(accessDeniedMessage(), "");
  assert.equal(accessDeniedMessage({ cabinet: true }), "Нужен доступ к кабинету и стенду. Откройте расширение.");
  assert.equal(accessDeniedMessage({ aniscan: true }), "Нужен доступ к AniScan. Откройте расширение.");
  assert.equal(
    accessDeniedMessage({ cabinet: true, aniscan: true }),
    "Нужен доступ к кабинету, стенду и AniScan. Откройте расширение."
  );
});

test("sign-in asks for the missing permission and does not send the user to log in instead", () => {
  const cabinetOnly = signInPrompts({
    permissionGranted: false,
    aniscanPermission: true,
    robotsEnabled: true,
    aniscanOpen: true,
    aniscanUrl: "https://aniscan.ru/",
    cabinetUrl: "https://moex.whitelist.capital/",
    cabinetOpen: false,
    accessError: accessDeniedMessage({ cabinet: true }),
  });
  assert.deepEqual(cabinetOnly, [{ text: "Нужен доступ к кабинету и стенду. Откройте расширение." }]);

  const both = signInPrompts({
    permissionGranted: false,
    aniscanPermission: false,
    robotsEnabled: true,
    aniscanOpen: false,
    aniscanUrl: "https://aniscan.ru/",
    cabinetUrl: "https://moex.whitelist.capital/",
    cabinetOpen: false,
    accessError: accessDeniedMessage({ cabinet: true, aniscan: true }),
  });
  assert.deepEqual(both, [{ text: "Нужен доступ к кабинету, стенду и AniScan. Откройте расширение." }]);

  const robotsOnly = signInPrompts({
    permissionGranted: true,
    aniscanPermission: false,
    robotsEnabled: true,
    aniscanOpen: false,
    aniscanUrl: "https://aniscan.ru/",
    cabinetUrl: "https://moex.whitelist.capital/",
    cabinetOpen: true,
    accessError: accessDeniedMessage({ aniscan: true }),
  });
  assert.deepEqual(robotsOnly, [{ text: "Нужен доступ к AniScan. Откройте расширение." }]);
});

test("sign-in login links appear only after that service is allowed", () => {
  const lines = signInPrompts({
    permissionGranted: true,
    aniscanPermission: true,
    robotsEnabled: true,
    aniscanOpen: false,
    aniscanUrl: "https://aniscan.ru/",
    cabinetUrl: "https://moex.whitelist.capital/",
    cabinetOpen: false,
    accessError: "",
  });
  assert.deepEqual(lines, [
    { text: "Чтобы видеть позиции, войдите в кабинет.", href: "https://moex.whitelist.capital/" },
    { text: "Чтобы следить за роботами, войдите в AniScan.", href: "https://aniscan.ru/" },
  ]);
  assert.deepEqual(
    signInPrompts({
      permissionGranted: true,
      aniscanPermission: false,
      robotsEnabled: false,
      aniscanOpen: false,
      aniscanUrl: "https://aniscan.ru/",
      cabinetUrl: "https://moex.whitelist.capital/",
      cabinetOpen: true,
      accessError: "",
    }),
    []
  );
});
