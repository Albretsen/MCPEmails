const translation = {
  title: 'Automatiske triageregler for e-post som kjører uten en modell i løkka',
  description:
    'Slik fungerer automasjoner i MCP Emails: et lagret søk pluss én fast handling, på et intervall, uten at en modell tolker e-posten din. Forhåndsvis, opprett, aktiver og les kjøreloggen.',
  coverAlt:
    'Uovervåkede triageregler for e-post i MCP Emails: et lagret søk pluss én fast handling på et fast intervall',
  content: `Hver morgen ber du agenten rydde bort støyen: arkiver byggevarslene, marker kvitteringene som lest, videresend fakturaene til regnskapsføreren. Det virker. Det koster også et modellkall hver gang, og tirsdag gjør det noe litt annet enn det gjorde mandag.

MCP Emails har en egen flate for akkurat den e-posten. En **automasjon** er et lagret søk pluss én fast handling, vurdert på et intervall, uten modell i løkka. E-post matches, aldri tolkes.

**Hopp til:** [Hva en regel er](#hva-en-automasjon-egentlig-er) · [Lag en](#lag-en-forhndsvis-opprett-aktiver) · [Hva den kan og ikke kan](#hva-en-regel-kan-og-ikke-kan-gjre) · [Når du bør la være](#nr-du-ikke-br-skrive-en-regel)

## Hva en automasjon egentlig er

Tre deler, og ikke noe mer.

- **Et filter.** De samme strukturerte kriteriene som et søk tar: \`from\`, \`to\`, \`cc\`, \`subject\`, \`body\`, \`text\`, \`unread\`, \`has_attachment\`, \`flagged\`, \`since\`, \`before\`. Minst ett kriterium kreves. Et tomt filter avvises blankt: på et raskt intervall ville det behandlet hele postkassen din, noe som langt oftere er en skrivefeil enn en hensikt.
- **Én handling.** Nøyaktig én, fra et lukket sett, låst når du oppretter regelen.
- **Et intervall.** \`interval_minutes\`, fra en fast stige: 15, 30, 60, 180, 360, 720 eller 1440 minutter. En stige i stedet for et fritt tall, fordi en regel som kjører hvert minutt ikke oppnår annet enn at du blir ratebegrenset.

Sett også \`max_messages_per_run\` (25 som standard, 200 som maksimum): det er skadeomfanget per kjøring, og det begrenser hvor mye e-post et dårlig filter rekker å røre før et menneske ser kjøreloggen. En regel kjører som den legitimasjonen som opprettet den, og fullmakten utledes på nytt ved hver kjøring, så å trekke tilbake nøkkelen stopper regelen ved neste kjøring.

## Hvorfor en regel slår å spørre agenten hver morgen

- **Kostnad.** En regel bruker ingen tokens. Morgensamtalen bruker dem daglig, på e-post du bestemte behandlingen av for måneder siden.
- **Gjentakbarhet.** Samme filter gir samme handling. Det finnes ingen «i dag valgte den annerledes», fordi den ikke velger noe.
- **Ingen hallusinerte trekk.** En regel kan ikke finne på en mappe, improvisere en mottaker eller handle på en instruksjon den fant inne i en e-posttekst.
- **Den kjører mens du sover.** MCP Emails er ellers basert på polling: agenten sjekker etter ny e-post når du ber den om det. Regelen er den delen som ikke må bes om noe.

## Agenttriage og uovervåkede regler gjør ulike jobber

Regler tar e-post som kan identifiseres fra konvolutten: en kjent avsender, et stabilt emneprefiks, et ulest-flagg, et vedlegg. Samtalen tar e-post som krever skjønn. Ikke uttrykk skjønn som et filter: en regel som gjetter hensikt ut fra en emnelinje, vil ta feil uten tilsyn, i stor skala, i ukevis. Hvis avgjørelsen krever at teksten forstås, hold den i en samtale og bruk [oppskriften for triage og oppsummering](/blog/ai-agent-triage-summarize-inbox).

## Lag en: forhåndsvis, opprett, aktiver

Tre trinn i den rekkefølgen. Rekkefølgen er selve sikkerhetsegenskapen.

### Trinn 1: tørrkjør filteret

\`automation_read\` med handlingen \`preview\` er en tørrkjøring. Den rapporterer hva et filter treffer akkurat nå, utfører ingenting, sender ingenting og krever ingen melding i dedupliseringsloggen, så den spiser aldri opp e-post som en senere ekte kjøring burde se. Forhåndsvis et ulagret \`filter\`, eller en lagret regel via \`automation_id\`.

> Forhåndsvis et automasjonsfilter på jobb-innboksen min: ulest e-post fra notifications@github.com. Vis meg hva det ville truffet akkurat nå. Ikke opprett eller endre noe.

Les gjennom treffene. Hvis noe på den listen ville vært feil å flytte, er filteret feil: stram det inn og forhåndsvis på nytt.

### Trinn 2: opprett regelen

\`automation\` med handlingen \`create\` trenger fire ting: \`name\`, \`filter\`, \`rule_action\` og \`interval_minutes\`. Merk deg de to nøklene, for de er lette å blande. På verktøyet velger \`action\` operasjonen (create, update, enable, disable, delete). \`rule_action\` er det **regelen** gjør med e-posten som treffer.

> Opprett en automasjon som heter «GitHub notifications» på jobb-innboksen min. Filter: fra notifications@github.com. Regelhandling: flytt til mappen Notifications. Intervall: 60 minutter.

Regelen opprettes **deaktivert**, og det er ikke et flagg du kan snu i samme kall. Aktivering er alltid en egen, uttrykkelig handling, slik at ingen uovervåket jobbing i postkassen starter som en bivirkning av å opprette en regel.

### Trinn 3: aktiver den

\`automation\` med handlingen \`enable\`. Regelen forfaller umiddelbart, kjører, og følger deretter intervallet sitt. Dette er øyeblikket der serveren begynner å røre postkassen din uten at noen ser på, og derfor får det sitt eget trinn. \`delete\` fjerner en regel, men beholder kjørehistorikken.

## Hva en regel kan og ikke kan gjøre

De fem regelhandlingene:

- **move** til en mappe du oppgir.
- **label**, brukt som en Gmail-etikett, en Outlook-kategori eller et IMAP-nøkkelord. På IMAP er en etikett et atom, så mellomrom blir til understreker.
- **mark_read**.
- **forward** til opptil ti mottakere, med en valgfri kort merknad. En videresending holdes **alltid** tilbake for [menneskelig godkjenning](/blog/approve-ai-agent-email-sends), uansett hva godkjenningsinnstillingen til innboksen sier: den innstillingen betyr «et menneske følger med på det som sendes fra denne postkassen», og en uovervåket kjører er nettopp det som bryter forutsetningen.
- **draft_reply**, som bare skriver et utkast og aldri sender. Malen erstatter \`{{sender_name}}\`, \`{{sender_email}}\`, \`{{subject}}\` og \`{{date}}\`, og ikke noe annet. Meldingstekster interpoleres aldri i det hele tatt.

Hva en regel ikke kan gjøre:

- **Slette e-post.** Sletting er ikke tilgjengelig for en automasjon. Å flytte til Papirkurv, Søppelpost eller Spam avvises også: alle leverandører tømmer disse på en tidtaker, så å arkivere dit er en sletting med forsinket lunte. Arkiver til en mappe du eier, og slett selv når du har lest kjøreloggen.
- **Tolke noe som helst.** Ingen oppsummering, ingen «hvis det høres hastende ut».
- **Lenke sammen to handlinger.** Etikettert og markert som lest er to regler over samme filter.

## Følg med på kjørehistorikken

\`automation_read\` med handlingen \`runs\` lister nylige kjøringer og tellerne deres: treff, behandlet, vellykket, mislykket, hoppet over. Handlingen \`list\` gir alle reglene i arbeidsområdet med tidsplan, handling og helse; \`get\` leser én i sin helhet, filter og feiltilstand inkludert.

Telleren det er verdt å forstå, er **skipped**, altså hoppet over. Et høyt antall hoppet over mot et lavt antall behandlet er ikke et problem: det betyr at en overlappende kjøring ble korrekt deduplisert. Hver regel krever en melding før den handler på den, så en omfordelt kjøring kan ikke flytte den samme e-posten to ganger. Regler stopper også seg selv etter fem mislykkede kjøringer på rad, i stedet for å male mot et ødelagt mappenavn i det uendelige.

## Når du ikke bør skrive en regel

- Avgjørelsen krever at teksten leses og forstås. Hold den i en samtale.
- Avsenderen er ikke stabil. Et filter mot et bevegelig mål eldes dårlig.
- Det er en engangsopprydding. Be agenten kjøre \`email_search_and_move\` én gang, og følg med.
- Du har ikke forhåndsvist den. En regel du ikke har tørrkjørt, er en planlagt gjetning.

## En realistisk innboks: noen få regler pluss én samtale

Fire regler som rydder bort alt det mekaniske, pluss én morgensamtale om det som er igjen:

1. Deploy-varsler fra en kjent avsender, flyttet til en mappe, hvert 60. minutt.
2. Kvitteringer og ordrebekreftelser, etikettert, hvert 180. minutt.
3. Fakturaer fra en kjent faktureringsadresse, videresendt til regnskapsføreren og holdt tilbake for din godkjenning, hvert 720. minutt.
4. En nyhetsbrevavsender du beholder, men aldri leser, markert som lest, hvert 1440. minutt.

Så spør du agenten om de tretti meldingene som er igjen, i stedet for de hundre og åtti som kom inn. Reglene prøver ikke å være smarte. De fjerner alt som aldri trengte intelligens.

## Regler teller mot planens handlinger

Hver handling en regel utfører, måles nøyaktig som en interaktiv handling, fordi effekten på postkassen er den samme. På **Free**-planen er det 150 fakturerbare e-posthandlinger per UTC-kalendermåned, der de første 7 dagene ikke telles. Den månedlige grensen gjelder arbeidsområder opprettet 2026-09-13 eller senere; arbeidsområder opprettet før er unntatt. Når et arbeidsområde når kvoten sin, blir regelen **satt på pause** i stedet for å feile: den forblir aktivert, og neste kjøring flyttes til det tidspunktet kvoteperioden slutter. **Personal** til $5 per måned fjerner den månedlige handlingsgrensen og tillater 3 tilkoblede innbokser. Se [priser](/pricing).

## Ofte stilte spørsmål

**Bruker en automasjon en LLM?**  
Nei. En regel er et lagret søk pluss én fast handling. E-post matches, aldri tolkes, og meldingstekster kopieres aldri inn i noe en regel produserer.

**Kan en regel slette e-posten min?**  
Nei. Sletting er ikke tilgjengelig for automasjoner, og å flytte e-post til Papirkurv, Søppelpost eller Spam avvises av samme grunn.

**Hvilket tilgangsnivå krever dette?**  
Enhver automasjonshandling krever \`manage:automations\`, en egen tildeling atskilt fra lesing og sending, fordi det å ha den betyr at en klient kan opprette stående regler som rører postkassen din uten tilsyn.

**Vil en videresendingsregel sende e-post på egen hånd?**  
Aldri. En videresending holdes alltid tilbake for menneskelig godkjenning uansett hva godkjenningsinnstillingen til innboksen din er, og en \`draft_reply\`-regel skriver bare et utkast.

## Neste steg

[Opprett en gratis konto](/signup), koble til en innboks, og be agenten forhåndsvise ett filter før den lagrer noe. Når treffene ser riktige ut, opprett regelen, aktiver den, og les kjøreloggen i morgen. [Dokumentasjonen](/docs) har den fullstendige verktøyreferansen.`,
};

export default translation;
