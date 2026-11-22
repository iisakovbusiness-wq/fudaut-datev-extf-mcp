/**
 * Ende-zu-Ende: startet den Server als eigenen Prozess und spricht ihn über stdio mit dem MCP-Client des offiziellen SDK an,
 * so wie ein Assistent es tut. Geprüft werden die fünf Werkzeuge, die Grenzen (ein Ordner, kein Überschreiben, Schreiben nur
 * nach Freigabe) und das Protokoll auf stderr.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { lesen } from "../src/extf.mjs";

const SERVER = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
const BEISPIEL = fileURLToPath(new URL("../beispiel/", import.meta.url));
const SAUBER = "EXTF_Buchungsstapel_Muster.csv", FEHLERHAFT = "EXTF_Buchungsstapel_Muster_fehlerhaft.csv";
let ordner, draussen, lesend, schreibend;

/** Server starten und verbinden. Gibt Client, Aufrufhilfe und das mitgeschriebene stderr zurück. */
async function verbinde(umgebung) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, DATEV_STAPEL_SCHREIBEN: "", ...umgebung }, stderr: "pipe" });
  const mitschrift = { text: "" };
  transport.stderr?.on("data", (d) => { mitschrift.text += d; });
  const client = new Client({ name: "test", version: "0.0.1" });
  await client.connect(transport);
  const ruf = (name, args) => client.callTool({ name, arguments: args });
  return { client, ruf, mitschrift };
}
const KOPF = { beraternummer: 1001, mandantennummer: 1, wjBeginn: "2026-01-01", bezeichnung: "Probe 03/2026", sachkontenrahmen: "03" };
const ZWEI = [
  { datum: "2026-03-02", umsatzCent: 5950, sollHaben: "S", konto: "4930", gegenkonto: "1200", buchungstext: "Büromaterial „Probe“", belegfeld1: "B-1" },
  { datum: "2026-03-05", umsatzCent: 119000, sollHaben: "H", konto: "8400", gegenkonto: "10001", buchungstext: "Rechnung; Wartung", buSchluessel: "9" },
];

before(async () => {
  ordner = fs.mkdtempSync(path.join(os.tmpdir(), "datev-stapel-test-"));
  draussen = fs.mkdtempSync(path.join(os.tmpdir(), "datev-stapel-draussen-"));
  for (const datei of [SAUBER, FEHLERHAFT]) fs.copyFileSync(path.join(BEISPIEL, datei), path.join(ordner, datei));
  fs.copyFileSync(path.join(BEISPIEL, SAUBER), path.join(draussen, "EXTF_Fremd.csv"));
  fs.mkdirSync(path.join(ordner, "unterordner"));
  /* Verknüpfung, die aus dem freigegebenen Ordner hinausführt (unter Windows als Junction, sonst als Symlink). */
  fs.symlinkSync(draussen, path.join(ordner, "abweg"), "junction");
  lesend = await verbinde({ DATEV_STAPEL_ORDNER: ordner });
  schreibend = await verbinde({ DATEV_STAPEL_ORDNER: ordner, DATEV_STAPEL_SCHREIBEN: "1" });
});
after(async () => {
  await lesend?.client.close();
  await schreibend?.client.close();
  /* Erst die Verknüpfung lösen, dann löschen: Beide Ordner hat dieser Test selbst angelegt. */
  fs.rmSync(path.join(ordner, "abweg"), { force: true });
  fs.rmSync(ordner, { recursive: true, force: true });
  fs.rmSync(draussen, { recursive: true, force: true });
});

test("der Server meldet sich und bietet genau fünf Werkzeuge an", async () => {
  assert.deepEqual(lesend.client.getServerVersion(), { name: "datev-stapel", version: "1.0.0" });
  const { tools } = await lesend.client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["stapel_pruefen", "stapel_lesen", "buchungen_suchen", "konten_salden", "stapel_schreiben"]);
  for (const t of tools) {
    assert.ok(t.description.length > 80, `${t.name}: Beschreibung fehlt`);
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.outputSchema, `${t.name}: ohne Ausgabeschema`);
    assert.equal(t.annotations.readOnlyHint, t.name !== "stapel_schreiben", `${t.name}: Hinweis „nur lesend“ falsch`);
  }
});

test("stapel_pruefen: sauberer Stapel ohne Befund, fehlerhafter mit 4 Fehlern und 5 Abweichungen", async () => {
  const gut = await lesend.ruf("stapel_pruefen", { pfad: SAUBER });
  assert.equal(gut.isError ?? false, false);
  assert.deepEqual({ ...gut.structuredContent, gruppen: undefined, befunde: undefined }, { ok: true, formatgerecht: true, zeichensatz: "windows-1252", buchungen: 14, sollCent: 1462565, habenCent: 2380, fehlerAnzahl: 0, abweichungAnzahl: 0, gruppen: undefined, befunde: undefined });
  assert.match(gut.content[0].text, /^Stapel ohne Befund\. 14 Buchungen gelesen/);

  const schlecht = await lesend.ruf("stapel_pruefen", { pfad: FEHLERHAFT });
  assert.equal(schlecht.isError ?? false, false, "ein Stapel mit Mängeln ist ein Ergebnis, kein Fehler des Werkzeugs");
  const d = schlecht.structuredContent;
  assert.equal(d.ok, false);
  assert.equal(d.fehlerAnzahl, 4);
  assert.equal(d.abweichungAnzahl, 5);
  assert.equal(d.befunde.length, 9);
  assert.deepEqual(d.gruppen.filter((g) => g.stufe === "fehler").map((g) => [g.feld, g.zeilen]), [["Umsatz (ohne Soll/Haben-Kz)", [3]], ["Belegdatum", [4]], ["Soll/Haben-Kennzeichen", [5]], ["Gegenkonto (ohne BU-Schlüssel)", [14]]]);
  assert.match(schlecht.content[0].text, /^4 Fehler, 5 Abweichung\(en\) von der Formatbeschreibung\./);
});

test("stapel_lesen: Kopf, Blättern, volles Datum", async () => {
  const r = await lesend.ruf("stapel_lesen", { pfad: SAUBER, ab: 10, anzahl: 10 });
  const d = r.structuredContent;
  assert.deepEqual({ ...d, buchungen: undefined }, { pruefungOk: true, beraternummer: "1001", mandantennummer: "1", wjBeginn: "20260101", zeitraumVon: "20260302", zeitraumBis: "20260331", bezeichnung: "Muster 03/2026", sachkontenrahmen: "03", festgeschrieben: false, gesamt: 14, ab: 10, buchungen: undefined });
  assert.deepEqual(d.buchungen.map((b) => b.zeile), [13, 14, 15, 16]);
  assert.deepEqual(d.buchungen[3], { zeile: 16, datum: "2026-03-31", umsatzCent: 2380, sollHaben: "H", konto: "1000", gegenkonto: "4930", buSchluessel: "", belegfeld1: "K-0331", buchungstext: "Briefmarken bar" });
  const standard = await lesend.ruf("stapel_lesen", { pfad: SAUBER });
  assert.equal(standard.structuredContent.buchungen.length, 14, "ohne Angabe gelten ab 0 und 50 Buchungen");
  const mitFehlern = await lesend.ruf("stapel_lesen", { pfad: FEHLERHAFT });
  assert.equal(mitFehlern.structuredContent.pruefungOk, false);
  assert.match(mitFehlern.content[0].text, /Achtung: Die Prüfung meldet 4 Fehler/);
});

test("buchungen_suchen und konten_salden rechnen in Cent", async () => {
  const s = await lesend.ruf("buchungen_suchen", { pfad: SAUBER, konto: "8400" });
  assert.deepEqual({ ...s.structuredContent, buchungen: undefined }, { pruefungOk: true, treffer: 3, summeSollCent: 404600, summeHabenCent: 0, gezeigt: 3, buchungen: undefined });
  const t = await lesend.ruf("buchungen_suchen", { pfad: SAUBER, text: "großhandel", von: "2026-03-15" });
  assert.deepEqual(t.structuredContent.buchungen.map((b) => b.zeile), [13]);
  const k = await lesend.ruf("konten_salden", { pfad: SAUBER });
  const bank = k.structuredContent.konten.find((x) => x.konto === "1200");
  assert.deepEqual(bank, { konto: "1200", sollCent: 357000, habenCent: 333850, saldoCent: 23150, buchungen: 7 });
  assert.equal(k.structuredContent.summeSollCent, k.structuredContent.summeHabenCent);
  assert.equal(k.structuredContent.konten.length, 15);
});

test("Grenze: nichts außerhalb des freigegebenen Ordners, auch nicht über eine Verknüpfung", async () => {
  /* Gegenprobe: Die Datei draußen ist lesbar und ein gültiger Stapel; abgelehnt wird sie allein wegen ihres Orts. */
  assert.equal(lesen(fs.readFileSync(path.join(draussen, "EXTF_Fremd.csv"))).ok, true);
  assert.ok(fs.existsSync(path.join(ordner, "abweg", "EXTF_Fremd.csv")), "die Verknüpfung muss wirklich hinausführen");
  const wege = ["../" + path.basename(draussen) + "/EXTF_Fremd.csv", path.join(draussen, "EXTF_Fremd.csv"), "abweg/EXTF_Fremd.csv", "unterordner/../../" + path.basename(draussen) + "/EXTF_Fremd.csv", "."];
  for (const pfad of wege) {
    for (const werkzeug of ["stapel_pruefen", "stapel_lesen", "buchungen_suchen", "konten_salden"]) {
      const r = await lesend.ruf(werkzeug, { pfad });
      assert.equal(r.isError, true, `${werkzeug} ${pfad}`);
      assert.match(r.content[0].text, /liegt nicht im freigegebenen Ordner/, `${werkzeug} ${pfad}`);
    }
  }
  const fehlt = await lesend.ruf("stapel_pruefen", { pfad: "EXTF_gibt_es_nicht.csv" });
  assert.equal(fehlt.isError, true);
  assert.match(fehlt.content[0].text, /gibt es im freigegebenen Ordner nicht/);
  const keinStapel = await lesend.ruf("stapel_pruefen", { pfad: "unterordner" });
  assert.equal(keinStapel.isError, true);
  assert.match(keinStapel.content[0].text, /ist keine Datei/);
});

test("ungültige Eingaben weist schon das Schema ab", async () => {
  for (const [name, args] of [["buchungen_suchen", { pfad: SAUBER, konto: "abc" }], ["buchungen_suchen", { pfad: SAUBER, von: "02.03.2026" }], ["stapel_lesen", { pfad: SAUBER, anzahl: 500 }], ["stapel_pruefen", {}]]) {
    const r = await lesend.ruf(name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(r.content[0].text, /Invalid arguments|validation/i);
  }
});

test("Grenze: Schreiben ist aus, solange der Betreiber es nicht einschaltet", async () => {
  const r = await lesend.ruf("stapel_schreiben", { ziel: "EXTF_Neu.csv", ...KOPF, buchungen: ZWEI });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Schreiben ist auf diesem Server ausgeschaltet/);
  assert.equal(fs.existsSync(path.join(ordner, "EXTF_Neu.csv")), false);
});

test("stapel_schreiben: neue Datei nach Formatbeschreibung, danach vom Prüfwerkzeug ohne Befund gelesen", async () => {
  const r = await schreibend.ruf("stapel_schreiben", { ziel: "EXTF_Neu.csv", ...KOPF, buchungen: ZWEI });
  assert.equal(r.isError ?? false, false, r.content[0].text);
  assert.deepEqual({ ...r.structuredContent, bytes: undefined }, { datei: "EXTF_Neu.csv", buchungen: 2, sollCent: 5950, habenCent: 119000, bytes: undefined, festgeschrieben: false });
  const bytes = fs.readFileSync(path.join(ordner, "EXTF_Neu.csv"));
  assert.equal(bytes.length, r.structuredContent.bytes);
  assert.ok(bytes.includes(Buffer.from([0x84, 0x50, 0x72, 0x6f, 0x62, 0x65, 0x93])), "„Probe“ muss in Windows-1252 stehen (0x84 … 0x93)");
  assert.equal(bytes.toString("latin1").split("\r\n").length, 5, "Kopfzeile, Überschriften, zwei Buchungen, Abschluss mit CRLF");
  assert.equal(bytes.includes(Buffer.from("\n")) && !bytes.toString("latin1").replaceAll("\r\n", "").includes("\n"), true, "nur CRLF");
  const gelesen = await lesend.ruf("stapel_pruefen", { pfad: "EXTF_Neu.csv" });
  assert.equal(gelesen.structuredContent.formatgerecht, true);
  const inhalt = await lesend.ruf("stapel_lesen", { pfad: "EXTF_Neu.csv" });
  assert.deepEqual(inhalt.structuredContent.buchungen.map((b) => [b.datum, b.umsatzCent, b.sollHaben, b.konto, b.gegenkonto, b.buSchluessel, b.buchungstext]), [["2026-03-02", 5950, "S", "4930", "1200", "", "Büromaterial „Probe“"], ["2026-03-05", 119000, "H", "8400", "10001", "9", "Rechnung; Wartung"]]);
});

test("stapel_schreiben überschreibt nie und speichert nichts, was die Prüfung nicht besteht", async () => {
  const vorher = fs.readFileSync(path.join(ordner, SAUBER));
  const doppelt = await schreibend.ruf("stapel_schreiben", { ziel: SAUBER, ...KOPF, buchungen: ZWEI });
  assert.equal(doppelt.isError, true);
  assert.match(doppelt.content[0].text, /gibt es schon; überschrieben wird nicht/);
  assert.ok(vorher.equals(fs.readFileSync(path.join(ordner, SAUBER))));

  const abgelehnt = [
    ["hinaus", { ziel: "../EXTF_Hinaus.csv", ...KOPF, buchungen: ZWEI }, /nicht im freigegebenen Ordner/],
    ["über die Verknüpfung", { ziel: "abweg/EXTF_Hinaus.csv", ...KOPF, buchungen: ZWEI }, /nicht im freigegebenen Ordner/],
    ["Ordner fehlt", { ziel: "gibtsnicht/EXTF_A.csv", ...KOPF, buchungen: ZWEI }, /Zielordner/],
    ["ohne EXTF_", { ziel: "Neu.csv", ...KOPF, buchungen: ZWEI }, /Invalid arguments|validation/i],
    ["Bezeichnung mit Umlaut", { ziel: "EXTF_B.csv", ...KOPF, bezeichnung: "März", buchungen: ZWEI }, /Invalid arguments|validation/i],
    ["zwei Wirtschaftsjahre", { ziel: "EXTF_C.csv", ...KOPF, buchungen: [ZWEI[0], { ...ZWEI[1], datum: "2027-02-01" }] }, /genau einem Wirtschaftsjahr/],
    ["Konto gleich Gegenkonto", { ziel: "EXTF_D.csv", ...KOPF, buchungen: [{ ...ZWEI[0], gegenkonto: "4930" }] }, /Konto und Gegenkonto sind gleich/],
    ["Zeichen ohne Platz in Windows-1252", { ziel: "EXTF_E.csv", ...KOPF, buchungen: [{ ...ZWEI[0], buchungstext: "Pfeil → hier" }] }, /Windows-1252/],
    ["keine Buchung", { ziel: "EXTF_F.csv", ...KOPF, buchungen: [] }, /Invalid arguments|validation/i],
  ];
  for (const [name, args, muster] of abgelehnt) {
    const r = await schreibend.ruf("stapel_schreiben", args);
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, muster, name);
  }
  assert.deepEqual(fs.readdirSync(ordner).sort(), ["EXTF_Buchungsstapel_Muster.csv", "EXTF_Buchungsstapel_Muster_fehlerhaft.csv", "EXTF_Neu.csv", "abweg", "unterordner"].sort(), "außer EXTF_Neu.csv darf nichts entstanden sein");
  assert.deepEqual(fs.readdirSync(draussen), ["EXTF_Fremd.csv"], "draußen darf nichts entstanden sein");
  const unter = await schreibend.ruf("stapel_schreiben", { ziel: "unterordner/EXTF_Unter.csv", ...KOPF, buchungen: ZWEI });
  assert.equal(unter.isError ?? false, false, unter.content[0].text);
  assert.equal(unter.structuredContent.datei, "unterordner/EXTF_Unter.csv");
});

test("Protokoll auf stderr: je Aufruf eine Zeile mit Werkzeug und Datei, ohne Buchungstexte und Beträge", async () => {
  await lesend.ruf("buchungen_suchen", { pfad: SAUBER, text: "Musterbau" });
  await schreibend.ruf("stapel_schreiben", { ziel: "EXTF_G.csv", ...KOPF, buchungen: [{ ...ZWEI[0], buchungstext: "Geheimer Text → hier" }] });
  await new Promise((r) => setTimeout(r, 200));
  for (const m of [lesend.mitschrift, schreibend.mitschrift]) {
    const zeilen = m.text.trim().split("\n");
    assert.match(zeilen[0], /^datev-stapel: bereit auf stdio/);
    const eintraege = zeilen.slice(1).map((z) => JSON.parse(z));
    assert.ok(eintraege.length >= 5);
    for (const e of eintraege) assert.deepEqual(Object.keys(e), ["zeit", "werkzeug", "datei", "ergebnis"]);
    assert.doesNotMatch(m.text, /Musterbau|Büromaterial|Geheimer|1190|5950/);
  }
  assert.ok(schreibend.mitschrift.text.includes('"ergebnis":"Fehler: Prüfung nicht bestanden, 1 Befund(e)"'));
  assert.ok(lesend.mitschrift.text.includes('"werkzeug":"buchungen_suchen","datei":"EXTF_Buchungsstapel_Muster.csv","ergebnis":"1 Treffer"'));
});
