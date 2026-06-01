export default {
  title: '7 ting AI-agenten din kan gjøre når den har tilgang til innboksen',
  description:
    'Sju konkrete ting en AI-agent kan gjøre med innbokstilgang: sortere ulest post, oppsummere tråder, skrive utkast til svar, finne vedlegg, følge opp og rute e-post.',
  coverAlt: 'Sju ting AI-agenten din kan gjøre med innbokstilgang via MCP — MCPEmails',
  content: `Når agenten din kan lese og sende ekte e-post, stopper demoteateret og det faktiske arbeidet begynner. Her er sju ting du kan få den til å gjøre i dag: rydde i den uleste haugen, oppsummere en lang tråd, skrive utkast til svar i din stil, grave frem det ene vedlegget, følge opp ubesvarte tråder, rute post til rett sted og sende deg et ukentlig sammendrag.

Hvert eksempel under bygger på ekte MCP-verktøy du kan kalle akkurat nå. Verktøyene er de samme enten du kobler til Gmail, Outlook, iCloud, Fastmail eller en vanlig IMAP-konto. Hvis du ennå ikke har koblet en agent til innboksen din, dekker [den komplette guiden til å gi AI-agenten din e-posttilgang](/blog/how-to-give-your-ai-agent-email-access) oppsettet; [gjennomgangen for å koble til på 2 minutter](/blog/connect-email-to-ai-agent-under-2-minutes) er den raske veien.

Ett ærlig forbehold med en gang, fordi det former halve denne listen: **MCP Emails er pollebasert, ikke push.** Det finnes ingen webhooks og ingen serverinitierte hendelser. Agenten får ikke et pling når det kommer post. Den sjekker etter en tidsplan. Det høres ut som en begrensning, og for noen få bruksområder er det det, men det betyr også at ingenting utløses uten en klokke du styrer. Jeg markerer der polling har betydning.

## Verktøysettet, i én setning

Alt her kjører på seks kjerneverktøy: \`list_inboxes\`, \`list_messages\`, \`read_email\`, \`search_emails\`, \`send_email\` og \`reply_to_email\`. Det finnes noen flere for å markere som lest, flagg, mapper, planlagt sending og kontaktoppslag. Det første kallet agenten din alltid bør gjøre, er \`list_inboxes\` for å finne de tilkoblede kontoene og deres \`inbox_id\`-verdier, slik at du aldri hardkoder en UUID inn i en prompt.

Promptene under er skrevet slik jeg faktisk ville tastet dem inn til Claude eller Cursor. Agenten finner selv ut hvilket verktøy den skal kalle.

### 1. Rydd i den uleste haugen

Morgeninnboksen er stort sett støy med tre ting begravd i seg som faktisk betyr noe. La agenten sortere det ut før du har drukket ferdig kaffen.

> Sjekk jobbinnboksen min for ulest post fra de siste 24 timene. Del den inn i «trenger svar i dag», «til orientering» og «nyhetsbrev/automatisk». For den første gruppen, gi meg én linje hver på hva de vil ha.

Under panseret kaller agenten \`list_messages\` med \`unread_only: true\` på innboksen \`list_inboxes\` returnerte, leser de få som ser viktige ut med \`read_email\`, og hopper over resten. Den kan markere åpenbar støy som lest så den slutter å fylle opp telleren. For en grundigere versjon av dette går [triagering- og oppsummeringsoppskriften](/blog/ai-agent-triage-summarize-inbox) verktøy for verktøy.

### 2. Oppsummer en lang tråd

Du blir lagt til i en tråd med 40 meldinger ved melding 38. Ingen kommer til å lese seg opp. Det gjør agenten.

> Les tråden med emnet «Q3 vendor migration» og fortell meg hvor det faktisk landet: hva ble bestemt, hvem eier hva, og eventuelle åpne spørsmål jeg må svare på.

\`search_emails\` finner tråden (den bruker leverandørens egen søkesyntaks, så Gmail-operatorer, Outlook KQL og IMAP-tekstsøk fungerer alle), så henter \`read_email\` ut den parsede rene teksten i hver melding. \`read_email\` kan også returnere renset HTML og vedlegg når du ber om det, men for et sammendrag er ren tekst raskere og billigere.

### 3. Skriv utkast til svar i din stil

Det er i utkastskrivingen agentene gjør seg fortjent. Modellen skriver det kjedelige svaret, du skummer over og sender.

> Skriv utkast til et svar på den siste meldingen fra Dana som takker nei til møtet, men foreslår to tidspunkter neste uke. Treff den vanlige tonen min, kort og direkte.

Agenten bruker \`reply_to_email\`, som setter trådhodene (In-Reply-To og References) for deg, slik at svaret havner i riktig samtale i stedet for å starte en ny. Svar støtter CC, BCC, HTML og vedlegg på opptil 10 MB totalt. Min regel: la agenten skrive utkast fritt, men hold et menneske på sendeknappen for alt som forlater huset. Behandle \`send_email\` og \`reply_to_email\` som stegene du faktisk gjennomgår.

### 4. Finn det ene vedlegget

Du vet at noen sendte den signerte kontrakten i mars. Du vet ikke hvilken av 200 tråder den ligger i. Søk slår skrolling.

> Finn den nyeste e-posten med et PDF-vedlegg fra noen på acme.com om fornyelsen, og hent ut vedlegget.

\`search_emails\` snevrer det inn med et leverandørspesifikt søk, og så returnerer \`read_email\` med \`include_attachments\` filen. Fordi e-posten hentes live og forkastes etter kallet, ligger ikke det vedlegget i en eller annen cache senere. [Arkitekturen der e-post aldri lagres](/blog/why-email-never-stored-matters) er grunnen til at det er trygt å peke en agent mot dette.

### 5. Oppfølgingspåminnelser (denne er polling)

«Svarte kunden noen gang?» er et spørsmål du glemmer å stille helt til det er for sent. En agent kan holde tråden for deg, men her biter virkeligheten med poll-ikke-push.

> Hver hverdag klokken 16, sjekk om noen har svart på forslagene jeg sendte denne uken. List opp de som fortsatt venter, med opprinnelig sendedato.

Det finnes ingen hendelse som vekker agenten når et svar kommer. I stedet kjører du den etter en tidsplan, en cron-jobb, klientens funksjon for planlagte oppgaver, hva enn som passer, og hver kjøring gjør jobben: \`search_emails\` for sendte forslag, så \`list_messages\` for å se hva som kom tilbake. Vil du at en gammel tråd skal dulte til seg selv, kan agenten til og med skrive og legge en oppfølging i kø. [Bygget av en autosvarer](/blog/build-email-auto-responder-mcp-agent) går gjennom polleløkken i detalj, inkludert hvordan du respekterer \`retry_after\`-verdien når du treffer en ratebegrensning, så du ikke hamrer løs på serveren.

### 6. Rut eller videresend til rett sted

Ikke all e-post er til deg. Noe hører hjemme i en delt postkasse, en sakshåndteringsadresse eller hos en kollega.

> Videresend alt som ser ut som en faktura til accounting@, og flagg kvitteringer jeg bør ta vare på til skatten.

Videresendingsverktøyet sender gjennom din egen leverandør, så meldingen beholder ryktet til ditt eget domene i stedet for å bli videreformidlet fra en tredjepart. Flagg og mapper lar agenten arkivere ting uten å slette dem. Dette er den typen stående regel som passer naturlig sammen med triageringen av ulest post i punkt 1, én kjøring, to resultater.

### 7. Et ukentlig sammendrag

Avslutt uken med et skriftlig sammendrag i stedet for et skyldbetynget blikk på en innboks du aldri ryddet.

> Fredag klokken 17: oppsummer alt jeg mottok denne uken som jeg ikke har svart på, gruppert etter avsender, med det aller viktigste handlingspunktet på tvers av alt. Send det til meg på e-post.

Dette syr sammen de andre: \`search_emails\` og \`list_messages\` for å samle inn uken, \`read_email\` for de som trenger detaljer, og så \`send_email\` for å levere sammendraget til deg selv. Som oppfølgingsdultet er det en planlagt kjøring, ikke en reaksjon. Du bestemmer frekvensen.

## Hva dette koster og hvor grensene ligger

Alle sju fungerer på [Free-planen](/pricing), som koster $0 med ubegrenset antall innbokser og verktøykall. Planene skiller seg på burst-rate, ikke på hva verktøyene kan gjøre. Free tillater 60 forespørsler per minutt, Solo ($12/month) øker til 300, og Team ($49/month) går til 1 000 med teamroller og SSO. Et ukentlig sammendrag berører knapt de takene; en aggressiv triageløkke hvert minutt på tvers av mange innbokser er der du ville merket Free-grensen og ønsket deg Solo.

Når du først treffer en grense, returnerer serveren en feil du kan prøve på nytt, med \`data.retry_after\` i sekunder. Respekter den. Og prøv aldri blindt på nytt et \`send_email\`-kall automatisk, for et nytt forsøk etter en timeout kan bety at to kopier av samme melding havner i noens innboks.

## Begynn med én

Ikke prøv å bygge alle sju på dag én. Velg triageringen eller det ukentlige sammendraget, få det kjedelig og pålitelig, og legg så til det neste. [Koble til en innboks](/signup) og la agenten din kjøre \`list_inboxes\` som sitt første grep. [Verktøyreferansen i dokumentasjonen](/docs) har de nøyaktige parameterne for hvert kall over.`,
};
