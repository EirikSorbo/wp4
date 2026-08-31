#!/usr/bin/env node
// Legger en forespørsel i Prosjekt-planleggerens innbokskø
// (brukere/<eier>/innboks) som Claude-brukeren. Appen er eneste skriver til
// prosjektdokumentene og utfører forespørselen trygt neste gang den er åpen;
// reglene gir Claude-brukeren KUN create her, aldri endring eller sletting.
//
// Bruk:
//   node fangst.mjs "Ringe tannlegen"                          todo i fangstprosjektet
//   node fangst.mjs "Skrive utkast" --prosjekt "UiA"           todo i navngitt prosjekt
//   node fangst.mjs "Rapportskriving" --oppgave --prosjekt UiA oppgave i navngitt prosjekt
//   node fangst.mjs "Purre svar" --frist 2026-08-20            med frist (YYYY-MM-DD)
//   node fangst.mjs "Les kap. 3" --prosjekt UiA --kategori Musikkhistorie
//   node fangst.mjs "Les denne" --url "https://..."            lenke i beskrivelsen
//   node fangst.mjs --fullfor "Send epost" --prosjekt UiA      fullfør todo (unik tittelmatch)
//   node fangst.mjs --fullfor "Rapport" --oppgave --prosjekt UiA  fullfør oppgave
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
let somOppgave = false;
for (let i = 0; i < arg.length; i++) {
  if (arg[i] === '--prosjekt') prosjektNavn = arg[++i] || '';
  else if (arg[i] === '--frist') frist = arg[++i] || '';
  else if (arg[i] === '--url') url = arg[++i] || '';
  else if (arg[i] === '--fullfor') fullforTittel = arg[++i] || '';
  else if (arg[i] === '--kategori') kategori = arg[++i] || '';
  else if (arg[i] === '--oppgave') somOppgave = true;
  else if (!tittel) tittel = arg[i];
}

if (!fullforTittel && (!tittel || !tittel.trim())) {
  console.error('Bruk: node fangst.mjs "tekst" [--prosjekt N] [--kategori K] [--oppgave] [--frist YYYY-MM-DD] [--url U]');
  console.error('      node fangst.mjs --fullfor "tittel" [--oppgave] [--prosjekt N]');
  process.exit(1);
}
if (frist && !/^\d{4}-\d{2}-\d{2}$/.test(frist)) {
  console.error('Ugyldig frist (bruk YYYY-MM-DD):', frist);
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

// ── Logg inn ────────────────────────────────────────────────────────────────
const inn = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + n.apiKey,
  { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: n.epost, password: n.passord, returnSecureToken: true }) });
if (!inn.ok) { console.error('Innlogging feilet:', (await inn.text()).slice(0, 300)); process.exit(1); }
const token = (await inn.json()).idToken;

// ── Bygg forespørselen ──────────────────────────────────────────────────────
const felter = {
  kilde: { stringValue: 'claude' },
  opprettet: { stringValue: new Date().toISOString() }
};
let beskrivelseAvHandling;

let prosjekt = null;
if (prosjektNavn || fullforTittel) {
  const bruker = await hentDok(token, 'brukere/' + n.eierUid);
  const prosjekter = ((bruker && bruker.prosjekter) || []).filter(p => p && p.id && !p.arkivert);
  prosjekt = prosjektNavn
    ? finnUnik(prosjekter, prosjektNavn, 'prosjekter')
    : null;
  if (fullforTittel && !prosjekt) {
    console.error('--fullfor krever --prosjekt, så riktig element fullføres.');
    process.exit(1);
  }
}

if (fullforTittel) {
  // Slå opp elementet i ferske prosjektdata og send målrettet fullfør-forespørsel.
  const data = await hentDok(token, 'brukere/' + n.eierUid + '/prosjekter/' + prosjekt.id) || {};
  const apne = (somOppgave ? (data.oppgaver || []) : (data.todos || []))
    .filter(x => x && !x.fullfort)
    .map(x => ({ id: x.id, navn: somOppgave ? (x.beskrivelse || '') : (x.tittel || '') }));
  const mal = finnUnik(apne, fullforTittel, somOppgave ? 'åpne oppgaver' : 'åpne to-dos');
  felter.type = { stringValue: 'fullfor' };
  felter.malId = { stringValue: mal.id };
  felter.malType = { stringValue: somOppgave ? 'oppgave' : 'todo' };
  felter.prosjektId = { stringValue: prosjekt.id };
  beskrivelseAvHandling = 'Fullfør ' + (somOppgave ? 'oppgave' : 'todo') + ' «' + mal.navn + '» i ' + prosjekt.navn;
} else if (prosjekt || somOppgave || frist || kategori) {
  // Typet forespørsel: bruker tittel-feltet (gamle app-versjoner ignorerer
  // dokumenter uten tekst-felt, så en utdatert enhet feilplasserer aldri noe).
  felter.type = { stringValue: somOppgave ? 'oppgave' : 'todo' };
  felter.tittel = { stringValue: tittel.trim().slice(0, 500) };
  if (prosjekt) felter.prosjektId = { stringValue: prosjekt.id };
  if (frist) felter.frist = { stringValue: frist };
  if (url) felter.url = { stringValue: url.slice(0, 500) };
  // Kategorien sendes ved NAVN; appen slår den opp i målprosjektet og lar
  // feltet stå tomt hvis navnet ikke finnes der (køen lager aldri kategorier).
  if (kategori) felter.kategori = { stringValue: kategori.trim().slice(0, 100) };
  beskrivelseAvHandling = 'Ny ' + (somOppgave ? 'oppgave' : 'todo') + ' «' + tittel.trim() + '»'
    + (prosjekt ? ' i ' + prosjekt.navn : ' i fangstprosjektet')
    + (kategori ? ' [' + kategori.trim() + ']' : '')
    + (frist ? ' (frist ' + frist + ')' : '');
} else {
  // Enkel fangst: samme format som Siri-snarveien, virker med alle app-versjoner.
  felter.tekst = { stringValue: tittel.trim().slice(0, 500) };
  if (url) felter.url = { stringValue: url.slice(0, 500) };
  beskrivelseAvHandling = 'Ny todo «' + tittel.trim() + '» i fangstprosjektet';
}

// ── Send ────────────────────────────────────────────────────────────────────
const r = await fetch(
  'https://firestore.googleapis.com/v1/projects/' + n.projectId + '/databases/(default)/documents/brukere/' + n.eierUid + '/innboks',
  { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: felter }) });
if (!r.ok) { console.error('Skriving feilet (' + r.status + '):', (await r.text()).slice(0, 300)); process.exit(1); }
console.log(beskrivelseAvHandling + ' — lagt i køen, utføres når appen er åpen.');
