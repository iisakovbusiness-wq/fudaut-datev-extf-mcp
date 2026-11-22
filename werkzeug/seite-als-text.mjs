/**
 * seite-als-text.mjs: speichert den sichtbaren Text einer Seite, die ohne JavaScript leer bleibt (die Formatbeschreibung auf
 * developer.datev.de ist so eine). Tabellen kommen dabei mit Tabulatoren zwischen den Zellen an; darauf baut
 * format-uebernehmen.py. Nur lesen, keine Anmeldung.
 *
 * Braucht das Paket playwright-core und einen installierten Chrome; beides ist nur für das Aktualisieren des Formats nötig
 * und deshalb keine Abhängigkeit des Servers:  npm install --no-save playwright-core
 *
 * Aufruf: node werkzeug/seite-als-text.mjs <adresse> <ausgabe.txt>
 */
import fs from "node:fs";
import { chromium } from "playwright-core";

const [adresse, ausgabe] = process.argv.slice(2);
if (!adresse || !ausgabe) { console.error("Aufruf: node werkzeug/seite-als-text.mjs <adresse> <ausgabe.txt>"); process.exit(2); }
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const seite = await (await browser.newContext({ locale: "de-DE" })).newPage();
  const antwort = await seite.goto(adresse, { waitUntil: "networkidle", timeout: 90000 });
  await seite.waitForTimeout(1500);
  const text = await seite.evaluate(() => document.body.innerText);
  fs.writeFileSync(ausgabe, `${seite.url()}\n\n${text}`);
  console.log(`HTTP ${antwort?.status()} ${seite.url()} | ${text.length} Zeichen nach ${ausgabe}`);
} finally { await browser.close(); }
