#!/usr/bin/env node
// Legger en eller flere forespørsler i Prosjekt-planleggerens innbokskø
// (brukere/<eier>/innboks) som Claude-brukeren. Appen er eneste skriver til
// prosjektdokumentene og utfører forespørslene trygt neste gang den er åpen;
// reglene gir Claude-brukeren KUN create her, aldri endring eller sletting.
//
// Bruk (ett element):
//   node fangst.mjs "Ringe tannlegen"                          todo i fangstprosjektet
//   node fangst.mjs "Skrive utkast" --prosjekt "UiA"           todo i navngitt prosjekt
//   node fangst.mjs "Rapportskriving" --oppgave --prosjekt UiA oppgave i navngitt prosjekt
//   node fangst.mjs "Purre svar" --frist 2026-08-20            med frist (YYYY-MM-DD)
//   node fangst.mjs "Les kap. 3" --prosjekt UiA --kategori Musikkhistorie
//   node fangst.mjs "Les denne" --url "https://..."            lenke i beskrivelsen
//   node fangst.mjs "Alle workshops gjennomført" --milepael --dato 2026-11-30 --prosjekt UiA
//   node fangst.mjs "Workshop 2" --aktivitet --dato 2026-10-06 --datoTil 2026-10-06 --prosjekt UiA
//   node fangst.mjs "Book reiser" --oppgave --prosjekt UiA --under "Alle workshops gjennomført"
//   node fangst.mjs --fullfor "Send epost" --prosjekt UiA      fullfør todo (unik tittelmatch)
//   node fangst.mjs --fullfor "Rapport" --oppgave --prosjekt UiA  fullfør oppgave
//
// Bruk (mange element i én omgang, én innlogging):
//   node fangst.mjs --fil plan.json
//   plan.json: { "prosjekt": "UiA", "kategori": "Såkorn", "elementer": [
//     { "type": "milepael", "tittel": "...", "dato": "2026-09-30", "beskrivelse": "..." },
//     { "type": "oppgave",  "tittel": "...", "frist": "2026-09-30", "under": "..." },
//     { "type": "todo",     "tittel": "..." } ] }
//   Appen utfører leveranser før oppgaver og to-dos, så «under» treffer også
//   leveranser som opprettes i samme omgang.
//
// Prosjekt- og tittelmatch: eksakt (uavhengig av store/små bokstaver) først,
// ellers unik delstreng. Tvetydig match stopper med kandidatliste.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HER = dirname(fileURLToPath(import.meta.url));
const NOKKEL_STI = join(HER, 'nokkel.json');

// ── Argumenter ──────────────────────────────────────────────────────────────
const arg = process.argv.slice(2);
let tittel = '', prosjektNavn = '', frist = '', url = '', fullforTittel = '', kategori = '';
let under = '', notat = '', dato = '', datoTil = '', fil = '';
let somOppgave = false, somMilepael = false, somAktivitet = false;
for (let i = 0; i < arg.length; i++) {
  if (arg[i] === '--prosjekt') prosjektNavn = arg[++i] || '';
  else if (arg[i] === '--frist') frist = arg[++i] || '';
  else if (arg[i] === '--url') url = arg[++i] || '';
  else if (arg[i] === '--fullfor') fullforTittel = arg[++i] || '';
  else if (arg[i] === '--kategori') kategori = arg[++i] || '';
  else if (arg[i] === '--under') under = arg[++i] || '';
  else if (arg[i] === '--notat') notat = arg[++i] || '';
  else if (arg[i] === '--dato') dato = arg[++i] || '';
  else if (arg[i] === '--datoTil') datoTil = arg[++i] || '';
  else if (arg[i] === '--fil') fil = arg[++i] || '';
  else if (arg[i] === '--oppgave') somOppgave = true;
  else if (arg[i] === '--milepael') somMilepael = true;
  else if (arg[i] === '--aktivitet') somAktivitet = true;
  else if (!tittel) tittel = arg[i];
}

const gyldigDato = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

if (!fil && !fullforTittel && (!tittel || !tittel.trim())) {
  console.error('Bruk: node fangst.mjs "tekst" [--prosjekt N] [--kategori K] [--oppgave] [--frist YYYY-MM-DD] [--under L] [--url U]');
  console.error('      node fangst.mjs "tittel" --milepael|--aktivitet --dato YYYY-MM-DD [--datoTil D] [--prosjekt N]');
  console.error('      node fangst.mjs --fullfor "tittel" [--oppgave] [--prosjekt N]');
  console.error('      node fangst.mjs --fil plan.json');
  process.exit(1);
}
for (const [navn, verdi] of [['--frist', frist], ['--dato', dato], ['--datoTil', datoTil]]) {
  if (verdi && !gyldigDato(verdi)) { console.error('Ugyldig ' + navn + ' (bruk YYYY-MM-DD):', verdi); process.exit(1); }
}
if ((somMilepael || somAktivitet) && !dato) {
  console.error('En leveranse trenger --dato YYYY-MM-DD.');
  process.exit(1);
}
if (!existsSync(NOKKEL_STI)) {
  console.error('nokkel.json mangler; se SETUP-CLAUDE.md.');
  process.exit(1);
}

const n = JSON.parse(readFileSync(NOKKEL_STI, 'utf8'));

// ── Firestore-hjelpere ──────────────────────────────────────────────────────
function utpakk(v) {
  if (v === null || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(utpakk);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, utpakk(x)]));
  return v;
}

async function hentDok(token, sti) {
  const r = await fetch('https://firestore.googleapis.com/v1/projects/' + n.projectId + '/databases/(default)/documents/' + sti,
    { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 404) return null;
  if (!r.ok) { console.error('Henting av ' + sti + ' feilet (' + r.status + '):', (await r.text()).slice(0, 200)); process.exit(1); }
  const d = await r.json();
  return Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, utpakk(v)]));
}

async function sendForespørsel(token, felter) {
  const r = await fetch(
    'https://firestore.googleapis.com/v1/projects/' + n.projectId + '/databases/(default)/documents/brukere/' + n.eierUid + '/innboks',
    { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: felter }) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
}

// Match: eksakt (case-insensitivt) først, ellers unik delstreng.
function finnUnik(kandidater, sokeNavn, hva) {
  const sok = sokeNavn.toLowerCase();
  let treff = kandidater.filter(k => k.navn.toLowerCase() === sok);
  if (!treff.length) treff = kandidater.filter(k => k.navn.toLowerCase().includes(sok));
  if (treff.length === 1) return treff[0];
  console.error(!treff.length
    ? 'Fant ingen ' + hva + ' som matcher «' + sokeNavn + '».'
    : 'Flere ' + hva + ' matcher «' + sokeNavn + '»: ' + treff.map(t => '«' + t.navn + '»').join(', '));
  if (!treff.length && kandidater.length)
    console.error('Tilgjengelige: ' + kandidater.map(k => '«' + k.navn + '»').join(', '));
  process.exit(1);
}

// Bygger Firestore-feltene for ett element. `pid` er alt oppslått prosjekt-id.
// Typene speiler køen i appen: leveranse (milepæl/aktivitet), oppgave, todo.
function byggFelter(el, pid) {
  const felter = {
    kilde: { stringValue: 'claude' },
    opprettet: { stringValue: new Date().toISOString() }
  };
  if (pid) felter.prosjektId = { stringValue: pid };
  const tit = String(el.tittel || '').trim().slice(0, 500);
  const erLeveranse = el.type === 'milepael' || el.type === 'milepæl' || el.type === 'aktivitet';

  if (erLeveranse) {
    felter.type = { stringValue: 'leveranse' };
    felter.leveranseType = { stringValue: el.type === 'aktivitet' ? 'aktivitet' : 'milepæl' };
    felter.tittel = { stringValue: tit };
    felter.dato = { stringValue: el.dato };
    if (el.datoTil) felter.datoTil = { stringValue: el.datoTil };
    if (el.beskrivelse) felter.beskrivelse = { stringValue: String(el.beskrivelse).slice(0, 500) };
  } else {
    felter.type = { stringValue: el.type === 'oppgave' ? 'oppgave' : 'todo' };
    felter.tittel = { stringValue: tit };
    if (el.frist) felter.frist = { stringValue: el.frist };
    if (el.url) felter.url = { stringValue: String(el.url).slice(0, 500) };
    if (el.notat) felter.notat = { stringValue: String(el.notat).slice(0, 500) };
    // Leveransen oppgis ved TITTEL; appen kobler den i målprosjektet og lar
    // koblingen stå tom hvis navnet er ukjent eller flertydig der.
    if (el.under) felter.under = { stringValue: String(el.under).slice(0, 200) };
  }
  // Kategorien sendes ved NAVN; appen slår den opp i målprosjektet og lar
  // feltet stå tomt hvis navnet ikke finnes der (køen lager aldri kategorier).
  if (el.kategori) felter.kategori = { stringValue: String(el.kategori).trim().slice(0, 100) };
  return felter;
}

function beskriv(el) {
  const hva = (el.type === 'milepael' || el.type === 'milepæl') ? 'Milepæl'
            : el.type === 'aktivitet' ? 'Aktivitet'
            : el.type === 'oppgave' ? 'Oppgave' : 'To-do';
  return hva + ' «' + String(el.tittel || '').trim() + '»'
    + (el.dato ? ' (' + el.dato + (el.datoTil && el.datoTil !== el.dato ? ' til ' + el.datoTil : '') + ')' : '')
    + (el.frist ? ' (frist ' + el.frist + ')' : '')
    + (el.under ? ' under «' + el.under + '»' : '');
}

// ── Logg inn ────────────────────────────────────────────────────────────────
const inn = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + n.apiKey,
  { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: n.epost, password: n.passord, returnSecureToken: true }) });
if (!inn.ok) { console.error('Innlogging feilet:', (await inn.text()).slice(0, 300)); process.exit(1); }
const token = (await inn.json()).idToken;

// Prosjektliste hentes én gang og gjenbrukes for alle oppslag.
let prosjekterCache = null;
async function prosjektIdFor(navn) {
  if (!navn) return null;
  if (!prosjekterCache) {
    const bruker = await hentDok(token, 'brukere/' + n.eierUid);
    prosjekterCache = ((bruker && bruker.prosjekter) || []).filter(p => p && p.id && !p.arkivert);
  }
  return finnUnik(prosjekterCache, navn, 'prosjekter').id;
}

// ── Batch fra fil ───────────────────────────────────────────────────────────
if (fil) {
  if (!existsSync(fil)) { console.error('Fant ikke fila:', fil); process.exit(1); }
  const plan = JSON.parse(readFileSync(fil, 'utf8'));
  const elementer = plan.elementer || [];
  if (!Array.isArray(elementer) || !elementer.length) { console.error('Fila har ingen «elementer».'); process.exit(1); }

  // Valider ALT før noe sendes, så en batch ikke lander halvveis.
  const pidCache = new Map();
  for (const [i, el] of elementer.entries()) {
    const nr = '#' + (i + 1);
    if (!el || !String(el.tittel || '').trim()) { console.error(nr + ' mangler tittel.'); process.exit(1); }
    if (el.type === 'fullfor') { console.error(nr + ': fullfor støttes bare med --fullfor, ikke i fil.'); process.exit(1); }
    const erLeveranse = el.type === 'milepael' || el.type === 'milepæl' || el.type === 'aktivitet';
    if (erLeveranse && !gyldigDato(el.dato)) { console.error(nr + ' («' + el.tittel + '») trenger gyldig dato.'); process.exit(1); }
    for (const felt of ['frist', 'dato', 'datoTil']) {
      if (el[felt] && !gyldigDato(el[felt])) { console.error(nr + ' har ugyldig ' + felt + ': ' + el[felt]); process.exit(1); }
    }
    const pNavn = el.prosjekt || plan.prosjekt || '';
    if (pNavn && !pidCache.has(pNavn)) pidCache.set(pNavn, await prosjektIdFor(pNavn));
  }

  let ok = 0;
  for (const el of elementer) {
    const pNavn = el.prosjekt || plan.prosjekt || '';
    const full = { ...el, kategori: el.kategori || plan.kategori || '' };
    try {
      await sendForespørsel(token, byggFelter(full, pidCache.get(pNavn) || null));
      console.log('  ✓ ' + beskriv(full));
      ok++;
    } catch (e) {
      console.error('  ✗ ' + beskriv(full) + ': ' + e.message);
    }
  }
  console.log('\n' + ok + ' av ' + elementer.length + ' lagt i køen, utføres når appen er åpen.');
  process.exit(ok === elementer.length ? 0 : 1);
}

// ── Ett element ─────────────────────────────────────────────────────────────
const pid = prosjektNavn ? await prosjektIdFor(prosjektNavn) : null;
if (fullforTittel && !pid) {
  console.error('--fullfor krever --prosjekt, så riktig element fullføres.');
  process.exit(1);
}

let felter, beskrivelseAvHandling;
if (fullforTittel) {
  // Slå opp elementet i ferske prosjektdata og send målrettet fullfør-forespørsel.
  const data = await hentDok(token, 'brukere/' + n.eierUid + '/prosjekter/' + pid) || {};
  const apne = (somOppgave ? (data.oppgaver || []) : (data.todos || []))
    .filter(x => x && !x.fullfort)
    .map(x => ({ id: x.id, navn: somOppgave ? (x.beskrivelse || '') : (x.tittel || '') }));
  const mal = finnUnik(apne, fullforTittel, somOppgave ? 'åpne oppgaver' : 'åpne to-dos');
  felter = {
    kilde: { stringValue: 'claude' },
    opprettet: { stringValue: new Date().toISOString() },
    type: { stringValue: 'fullfor' },
    malId: { stringValue: mal.id },
    malType: { stringValue: somOppgave ? 'oppgave' : 'todo' },
    prosjektId: { stringValue: pid }
  };
  beskrivelseAvHandling = 'Fullfør ' + (somOppgave ? 'oppgave' : 'todo') + ' «' + mal.navn + '»';
} else if (pid || somOppgave || somMilepael || somAktivitet || frist || kategori || under) {
  // Typet forespørsel: bruker tittel-feltet (gamle app-versjoner ignorerer
  // dokumenter uten tekst-felt, så en utdatert enhet feilplasserer aldri noe).
  const el = { type: somMilepael ? 'milepael' : somAktivitet ? 'aktivitet' : somOppgave ? 'oppgave' : 'todo',
               tittel, frist, dato, datoTil, kategori, under, notat, url, beskrivelse: notat };
  felter = byggFelter(el, pid);
  beskrivelseAvHandling = beskriv(el);
} else {
  // Enkel fangst: samme format som Siri-snarveien, virker med alle app-versjoner.
  felter = {
    kilde: { stringValue: 'claude' },
    opprettet: { stringValue: new Date().toISOString() },
    tekst: { stringValue: tittel.trim().slice(0, 500) }
  };
  if (url) felter.url = { stringValue: url.slice(0, 500) };
  beskrivelseAvHandling = 'To-do «' + tittel.trim() + '» i fangstprosjektet';
}

try {
  await sendForespørsel(token, felter);
} catch (e) {
  console.error('Skriving feilet:', e.message);
  process.exit(1);
}
console.log(beskrivelseAvHandling + ' lagt i køen, utføres når appen er åpen.');
