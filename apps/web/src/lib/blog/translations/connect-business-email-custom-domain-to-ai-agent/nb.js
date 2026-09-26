const translation = {
  title: 'Koble en bedrifts-e-post på eget domene til AI-agenten din (IMAP-oppsett)',
  description:
    'Oppsettsguide for deg@dittfirma.no: finn ut hvem som faktisk drifter e-posten din, koble til Google Workspace, Zoho, Fastmail, Migadu, Titan, Rackspace, IONOS eller cPanel, og fiks avsendernavnet før agenten svarer.',
  coverAlt:
    'Koble en bedrifts-e-post på eget domene til en AI-agent med MCP Emails',
  content: `> **På Microsoft 365?** Hvis bedriftspostkassen din viser seg å være en Microsoft-tenant, hjelper denne guiden deg med å bekrefte det. Koble den til med **Outlook** og Logg inn med Microsoft i stedet for IMAP; IT-ansvarlig må kanskje først godkjenne appen én gang for hele organisasjonen. [Guiden for Outlook og Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp) viser stegene.

Nesten alle guider for å koble e-post til en AI-agent tar for gitt at adressen din slutter på gmail.com. Bedrifts-e-post er noe annet: domenet sier ingenting om hvem som drifter postkassen, noen andre kan styre om e-postklienter i det hele tatt får logge inn, og det agenten sender går til kundene dine i ditt navn. Dette er guiden for deg@dittfirma.no.

**Gå til leverandøren din:** [Google Workspace](#google-workspace) · [Zoho Mail](#zoho-mail) · [Fastmail og Migadu](#fastmail-og-migadu) · [Titan Email](#titan-email) · [Rackspace Email](#rackspace-email) · [IONOS](#ionos) · [cPanel og delte webhoteller](#cpanel-og-delte-webhoteller)

## Hvorfor en bedriftspostkasse er vanskeligere enn en privat

- **Noen andre kan styre apptilgangen.** En Google Workspace-administrator kan slå av apppassord for hele domenet. Zoho leverer postkasser med IMAP avslått, Titan med tredjepartstilgang avslått. Alle tre avviser innloggingen på nøyaktig samme måte som et feil passord.
- **Adressen din navngir ikke e-postserveren din.** Vår egen hello@mcpemails.com driftes av Migadu, og ingenting i domenet sier det. Å gjette \`mail.dittfirma.no\` treffer som regel ingenting.
- **SMTP er ikke alltid et speilbilde av IMAP.** Rackspace serverer begge fra én umerket vert, og OVH Hosted Exchange lytter ikke på 465 i det hele tatt, men krever 587 med STARTTLS.
- **Avsendernavnet ser kundene dine.** Et svar som går ut uten navn blir en supporthenvendelse.

## Steg 1: Finn ut hvem som faktisk drifter e-posten din

MCP Emails prøver å svare på dette for deg. Skriv adressen din i IMAP-skjemaet, vent et halvt sekund, så sjekkes fire kilder i rekkefølge: en tabell over leverandørene som har forårsaket reelle tilkoblingsfeil, domenets RFC 6186-tjenesteoppføringer, MX-oppføringen din matchet mot den samme tabellen, og Mozillas autokonfigurasjonsdatabase. Ingenting fylles ut med mindre begge halvdelene løser seg.

Vil du sjekke selv først:

\`\`\`
dig +short MX dittfirma.no
dig +short SRV _imaps._tcp.dittfirma.no
\`\`\`

Tjenesteoppføringer oppgir vert og port direkte, men de fleste domener publiserer ingen, så det er som regel MX-svaret du sitter igjen med:

- Slutter på \`.l.google.com\`, eller \`smtp.google.com\`: Google Workspace.
- \`mx.zoho.com\` eller en regional variant: Zoho Mail.
- \`aspmx1.migadu.com\`: Migadu. \`mx1.titan.email\`: Titan, uansett hvilket merke du kjøpte det under.
- Et MX-navn hos Microsoft: en Microsoft 365-tenant. Koble den til med **Outlook**, ikke IMAP.
- Navnet på webhotellets egen server: en cPanel- eller Plesk-postkasse.

## Steg 2: Følg veien for din leverandør

Åpne **Inboxes → Connect Inbox** i dashbordet og velg ruten som passer.

### Google Workspace

Workspace kobles til med et **Google-apppassord** over IMAP som standard (\`imap.gmail.com\` på 993, \`smtp.gmail.com\` på 465); OAuth er også tilgjengelig. Apppassord finnes bare når totrinnsbekreftelse er på, og en administrator kan slå dem av for hele domenet. Da er Google-siden rett og slett utilgjengelig for deg. Administratorer kan også begrense tredjeparts OAuth-apper under Sikkerhet → API-kontroller, noe som blokkerer den veien på Googles eget samtykkeskjermbilde. Er begge stengt, snakk med administratoren din.

### Zoho Mail

**Slå på IMAP-tilgang** først, under Innstillinger → E-postkontoer → adressen → IMAP-tilgang. Den er av som standard og settes per postkasse, så å slå den på for deg selv gjør ingenting for en kollega. Lag også et **applikasjonsspesifikt passord** hvis tofaktorautentisering er på.

Verten din avhenger av to ting Zoho aldri viser samtidig: hvilket av de seks regionale datasentrene kontoen ligger i (\`.com\`, \`.eu\`, \`.in\`, \`.com.au\`, \`.jp\`, \`zohocloud.ca\`), og om det er en betalt organisasjonskonto på eget domene, som bruker \`imappro\` og \`smtppro\` for den regionen. MCP Emails spør om begge og bygger vertsnavnet.

### Fastmail og Migadu

Fastmail bruker et **apppassord** med Mail-tilgang (IMAP/SMTP), fra Settings → Privacy & Security: \`imap.fastmail.com\` på 993 og \`smtp.fastmail.com\` på 465. En guide som ber deg logge inn på Fastmail med OAuth er utdatert.

Migadu bruker **postkassepassordet**, ikke passordet til Migadu-kontoen din, som styrer domener og fakturering og ikke autentiserer e-post i det hele tatt. Et alias har ikke noe passord, så hvis adressen du vil bruke er et alias, legg til en **identitet** på postkassen og gi den sitt eget. Vertene er \`imap.migadu.com\` og \`smtp.migadu.com\`. [Guiden for iCloud og IMAP](/blog/connect-icloud-fastmail-imap-to-claude) har stegene for apppassord.

### Titan Email

Titan avviser alle e-postklienter til du slår på én bryter: **Settings → Enable Titan on Other Apps**. Før det feiler innloggingen som et feil passord. Titan selges også under andres merkenavn, så hvor du kjøpte det avgjør vertsnavnene dine: GoDaddy selger det som Professional Email på \`imap.secureserver.net\` og \`smtpout.secureserver.net\`, Hostinger som Titan på \`imap.titan.email\`. Titans egen feilsøking ber deg slå av tofaktor, men det trenger du ikke, for Titan støtter applikasjonspassord.

### Rackspace Email

Begge vertene er \`secure.emailsrvr.com\`, både inn og ut, uansett hvilket domene du har. Navnet bærer ingen Rackspace-merking, så folk "retter" det til noe som ser mer troverdig ut, og da virker ingenting. Bruk postkassepassordet fra Cloud Office-kontrollpanelet. Med flerfaktorautentisering på slutter det passordet å virke over IMAP og SMTP mens det fortsatt virker i nettpostkassen, og da trenger du et apppassord. Rackspace selger også Hosted Exchange, som ikke kan kobles til her, og videreselger Microsoft 365, som kobles til med **Outlook** i stedet for IMAP.

### IONOS

IONOS gir **hver adresse sitt eget e-postpassord**, satt i kontrollpanelet under Email. IONOS-innloggingen din, som veldig ofte også er en e-postadresse, autentiserer kontrollpanelet og ingenting annet, og akkurat den forvekslingen står bak de fleste IONOS-feilene i loggene våre. IONOS svarer både på 993 med TLS og 143 med STARTTLS, så å veksle mellom dem er bortkastet tid: ett arbeidsområde gjorde tolv forsøk på rad med veksling, og passordet var problemet hele veien.

### cPanel og delte webhoteller

Det finnes ingen cPanel-e-posttjeneste, bare webhotellets egen server, så panelet er eneste autoritet på navnet. Åpne **Email Accounts**, klikk **Connect Devices** og kopier verdiene fra **Mail Client Manual Settings**, fra den sikre SSL/TLS-kolonnen. Brukernavnet er hele e-postadressen, aldri cPanel-innloggingen din, og legitimasjonen er postkassepassordet. Ingen apppassord, ingen OAuth. Plesk fungerer på samme måte.

## Når ingenting oppdages og du må fylle inn selv

Gi MCP Emails fire ting per protokoll: vert, port, sikkerhetsmodus og hele adressen din som brukernavn. Konvensjonene er faste, og skjemaet holder port og sikkerhet i takt så de ikke kommer i utakt:

- IMAP **993** er implisitt TLS; IMAP **143** er STARTTLS.
- SMTP **465** er implisitt TLS; SMTP **587** er STARTTLS, og **25** er STARTTLS hos små verter som ikke tilbyr annet.

Å blande disse var den klart største årsaken til mislykkede generiske tilkoblinger: STARTTLS på 993 blir stående og vente på en hilsen en ren TLS-lytter aldri sender, og implisitt TLS på 143 feiler i håndtrykket. Du trenger ikke lenger treffe på første forsøk. En tilkobling som aldri fikk en brukbar økt, prøves på nytt over de andre standardtransportene, opptil tre forsøk per protokoll, med det du ba om først. Et passord serveren avviste, prøves aldri på nytt: å sende det igjen ville bare tredoble antallet feilede innlogginger leverandøren din bruker til å låse kontoen.

Sending forhandler om én ting til som du aldri ser. Exchange-liknende verter annonserer **LOGIN** uten PLAIN, så MCP Emails leser hva serveren tilbyr, prøver PLAIN først når begge finnes, og faller tilbake på LOGIN. En avvist mekanisme rapporteres aldri som feil passord.

## Sett avsendernavnet før agenten svarer

Alt agenten din sender bygger From-headeren fra ett felt: visningsnavnet på postkassen, foran adressen din. La det stå tomt, og e-posten går ut med bare adressen.

Sett det per postkasse på detaljsiden for postkassen, der en forhåndsvisning viser headeren slik mottakerne ser den. En agent kan også sette det, med \`signature_set\` og argumentet \`sender_name\`. Navn har en grense på 100 tegn, og kontrolltegn og vinkelparenteser fjernes slik at et navn ikke kan smugle inn en andre adresse i headeren. Sett en signatur mens du er der: [e-postsignaturer for Claude](/blog/email-signatures-for-claude).

## Feilsøking av bedrifts-e-post

- **Innloggingen avvises og passordet er helt sikkert riktig.** Sjekk bryteren først: IMAP-tilgang hos Zoho, tredjepartstilgang hos Titan, apppassord hos Workspace, flerfaktor hos Rackspace.
- **Du bruker rett og slett feil passord.** Migadu, IONOS, Rackspace og cPanel skiller alle kontrollpanel-innloggingen fra postkassepassordet, og begge er som regel e-postadresser.
- **Den får tidsavbrudd i stedet for å feile.** Da er det verten eller porten, ikke legitimasjonen. Les vertsnavnet på nytt i leverandørens eget panel.
- **E-posten leses, men sendes ikke.** Den utgående halvdelen har sin egen vert, port og sikkerhetsmodus, og noen verter lytter ikke på 465. Bekreft at du ga \`send:email\`.
- **Det er en Microsoft 365-postkasse.** Kjøpt direkte eller videresolgt av GoDaddy, IONOS eller Rackspace er den fortsatt en Microsoft-tenant. Koble den til med **Outlook** og Logg inn med Microsoft, ikke IMAP. Hvis Microsoft sier at administratorgodkjenning kreves, sender du lenken dashbordet viser til IT-ansvarlig.

[Leverandørmatrisen](/docs/providers) og [leverandørsidene](/connect) har detaljene for hver enkelt.

## FAQ

**Hvordan finner jeg ut hvem som drifter bedriftens e-post?**
Slå opp MX-oppføringen til domenet, eller skriv adressen i tilkoblingsskjemaet og la autodeteksjonen sjekke MX og tjenesteoppføringene for deg.

**Kan jeg koble til en Google Workspace-adresse?**
Ja, med et Google-apppassord over IMAP, eller med OAuth. Administratoren din kan blokkere begge: apppassord kan slås av for hele domenet, og tredjeparts OAuth-apper kan begrenses under API-kontroller.

**Hva om webhotellet mitt ikke publiserer IMAP-innstillinger?**
Fyll dem inn selv: vert, port, sikkerhetsmodus og hele adressen din som brukernavn. Svarer ikke den første transporten, prøves standardalternativene automatisk.

**Lagrer MCP Emails bedriftens e-post?**
Nei. Innholdet i meldingene hentes live fra leverandøren din ved hver forespørsel og forkastes. Bare den krypterte legitimasjonen til leverandøren beholdes.

**Er én postkasse nok på gratisplanen?**
Free kobler til 1 postkasse. Personal koster 5 $/måned for 3 postkasser uten månedlig handlingstak, og Pro 15 $/måned for ubegrenset antall. Se [priser](/pricing).

## Neste steg

[Opprett en gratis konto](/signup), koble til bedriftspostkassen, sett avsendernavnet og legg \`https://mcpemails.com/api/mcp\` inn i klienten din. Be den så kalle \`inbox_list\` og oppsummere gårsdagens uleste e-post før du gir den noe som kan sende.`,
};

export default translation;
