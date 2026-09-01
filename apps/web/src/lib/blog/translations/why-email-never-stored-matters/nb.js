const translation = {
  title: 'Hvorfor «e-post lagres aldri» er avgjørende når du kobler AI til innboksen',
  description:
    'E-post lagres aldri betyr at MCP Emails henter posten din live og kaster den, og beholder kun et kryptert token. Se hvorfor det slår verktøy som kopierer hele innboksen.',
  coverAlt: 'E-post hentet live og kastet kontra en andre kopi lagret i en leverandørs database',
  content: `Når du kobler en AI-agent til innboksen din, er det aller viktigste spørsmålet hvor e-posten din havner. Med MCP Emails er svaret: ingen steder. Hvert verktøykall henter posten din live fra Gmail, Microsoft Graph eller IMAP-serveren din, gir den til agenten og kaster den. Det eneste vi beholder, er et kryptert token slik at neste kall kan skje.

Det høres ut som en liten implementasjonsdetalj. Det er det ikke. Det er forskjellen på å gi en agent en *nøkkel til huset ditt* og å gi den en *fotokopi av alt i huset ditt*, oppbevart for alltid i en andres arkivskap. Mange «AI-e-post»-verktøy gjør stille det andre. Dette innlegget handler om hvorfor det betyr noe, og hvordan arkitekturen faktisk skiller seg.

## To måter å gi en agent e-posten din på

Det finnes egentlig bare to design, og de fleste produkter faller tydelig i én leir.

**Kopier-alt (synkroniser-og-lagre).** Verktøyet kobler seg til postkassen din én gang og henter så meldingene dine inn i sin egen database — ofte kontinuerlig. Innboksen din blir speilet inn i deres infrastruktur slik at den kan indekseres, embeddes i et vektorlager, mates til en modell eller leveres tilbake raskt. Agenten leser fra *deres* kopi, ikke fra leverandøren din.

**Live-henting (aldri-lagret).** Verktøyet holder kun på en legitimasjon. Når agenten trenger en melding, ringer serveren leverandøren din i sanntid, returnerer resultatet og kaster brødteksten. Ingenting av innholdet beholdes. Slik fungerer MCP Emails.

Kopier-alt-modellen er populær fordi den er lett å bygge og får søk til å føles umiddelbart. Men den endrer hva du faktisk samtykker til når du klikker «Connect». Du gir ikke tilgang. Du autoriserer en duplikat.

## Hva en «synkronisert» innboks faktisk samler opp

Når et verktøy først har kopiert posten din, følger fire ting med, enten leverandøren reklamerer for dem eller ikke.

### En andre kopi av posten din som du ikke kontrollerer

Den ekte innboksen din ligger hos Google eller Microsoft eller Fastmail, bak deres sikkerhetsteam og deres bruddhistorikk. Et synkronisert verktøy lager en andre, fullverdig kopi et annet sted — en oppstartsbedrifts Postgres-instans, en S3-bøtte, en søkeindeks. Hver lenke for tilbakestilling av passord, hver juridisk tråd, hvert medisinsk resultat og hver tofaktor-reservekode du noensinne har mottatt, finnes nå på et sted du ikke har vurdert og ikke kan revidere.

### En større angrepsflate ved brudd

Dette er den delen folk undervurderer. Hvis leverandørens database lekker, får angriperen ikke *legitimasjonen* din — de får *posten* din, allerede dekryptert og indeksert, klar til å leses. Ingen grunn til å logge inn på kontoen din. Den mest skadelige delen av et e-postbrudd er e-posten selv, og et kopier-alt-verktøy har vennligst samlet den på ett sted. Du arver deres sikkerhetsnivå på toppen av leverandørens.

### Oppbevaring du må tenke på

Hvor blir kopien av når du kobler fra? I et velkjørt synkroniseringsverktøy er sletting en bakgrunnsjobb som *bør* kjøre. I et slurvete et blir meldingene dine liggende i sikkerhetskopier og embeddinger lenge etter at du har dratt. Med et live-hentings-design finnes det ingenting å slette, fordi ingenting ble beholdt. Å trekke tilbake tilgangen i dashbordet er hele historien.

### Risiko for trening og «produktforbedring»

Et lagret korpus med ekte e-post er uimotståelig. Det er fristende å bruke det til å forbedre søkerangering, finjustere en modell eller trene en klassifikator. Selv med gode hensikter — så snart posten din ligger i en database, er spørsmålet «kan dette bli brukt til noe jeg ikke meldte meg på?» permanent åpent. Hvis dataene aldri ble lagret, dukker spørsmålet aldri opp.

## Hvordan live-henting faktisk fungerer

Her er veien et enkelt \`email_read\`-kall (handling \`read\`) tar gjennom MCP Emails:

\`\`\`
agent  →  MCP-server  →  isolert Edge Function
                              ↓ dekrypter token (i minne)
                         leverandøren din (Gmail / Graph / IMAP)
                              ↓ meldingsbrødtekst
agent  ←  tolket resultat  ←  Edge Function
                         (brødtekst kastet, ingenting skrevet)
\`\`\`

Legitimasjonen er det eneste som ligger lagret, og den er kryptert med **AES-256-GCM**. Dekryptering skjer kun inne i en isolert Edge Function ved kalltidspunktet, og krypteringsnøkkelen er en miljøhemmelighet lagret separat fra databasen — så en database-dump alene er ubrukelig. Selve meldingen rører aldri varig lagring. Den tolkes, returneres til agenten din og er borte.

Sending fungerer på samme måte og legger til én garanti til: utgående post går gjennom *din* leverandør — Gmail API, Microsoft Graph eller din egen SMTP. Vi videresender aldri fra vårt eget domene, så leveringsdyktigheten og domeneomdømmet ditt forblir helt og holdent dine. Det finnes ingen delt sendepool som kan lande deg i en annens spam-omdømme.

Vil du ha den dypere mekanikken bak legitimasjonsmodellen — OAuth-tokens kontra app-passord og hvorfor begge forblir krypterte — skrev jeg om det i [OAuth vs. API-nøkler for AI-tilgang til e-post](/blog/oauth-vs-api-keys-ai-email-access).

## Den ærlige avveiningen

Aldri-lagret er ikke gratis. Det er en reell kostnad, og jeg vil heller navngi den enn å late som den ikke finnes.

Fordi vi ikke holder på en lokal indeks, kjører søk mot leverandørens søk hver gang. Du får [leverandør-eget søk](/docs) — Gmail-operatorer, Outlook KQL, IMAP-tekstsøk — som er kraftig, men det er deres ventetid og deres spørringssemantikk, ikke en egen indeks finjustert av oss. Og det er ingen push: vi kan ikke varsle agenten din i det øyeblikket post ankommer, fordi vi ikke overvåker en synkronisert kopi. For å reagere på ny post poller agenten din (for eksempel \`email_read\` med handling \`list\` og \`unread_only: true\` etter en tidsplan).

For de fleste er det en enkel avveining. Litt tregere søk og en pollesløyfe, i bytte mot aldri å lage en andre kopi av dine mest sensitive data. Det tar jeg gjerne.

## Hva du bør spørre ethvert AI-e-postverktøy om

Før du kobler noe til innboksen din, still leverandøren fire direkte spørsmål. Svarene forteller deg hvilken leir de er i.

- **Lagrer dere e-postinnholdet mitt, eller henter dere det live per forespørsel?** «Henter live, kaster umiddelbart» er svaret du vil ha.
- **Hva er det nøyaktig som beholdes?** Det bør være én enkelt kryptert legitimasjon, ingenting om meldingsinnhold.
- **Er legitimasjonen kryptert i lagring, og hvor ligger nøkkelen?** Separat fra databasen er det riktige svaret.
- **Går sending gjennom min leverandør eller deres?** Din beskytter domeneomdømmet ditt; deres slår det sammen med fremmedes.

Hvis et verktøy ikke kan svare på dette klart og tydelig, er det også informasjon. Dette er den samme linsen jeg ville brukt på det bredere sikkerhetsspørsmålet i [Er det trygt å gi en AI-agent tilgang til e-posten din?](/blog/is-it-safe-to-give-ai-agent-email-access) — det er arkitekturen under markedsføringen som faktisk avgjør risikoen din.

## Hvor dette passer inn

Aldri-lagret-modellen er én brikke i en større beslutning: hvordan du kobler en agent til en ekte innboks uten å gjøre noe du vil angre på. Den [komplette 2026-guiden til å gi AI-agenten din tilgang til e-post](/blog/how-to-give-your-ai-agent-email-access) dekker hele bildet, og hvis du vurderer å kjøre din egen server, går [hosted vs. selvhostet Gmail MCP](/blog/hosted-vs-self-hosted-gmail-mcp-server) inn på hvem som holder krypteringsnøkkelen i hvert tilfelle.

Du trenger ikke å velge mellom å gi agenten din nyttig innbokstilgang og å holde posten din ute av en tredjeparts database. Med live-henting får du begge deler. [Koble til en innboks](/signup), så kan du trekke tilbake tilgangen med ett klikk — og det er ingenting igjen når du gjør det.`,
};

export default translation;
