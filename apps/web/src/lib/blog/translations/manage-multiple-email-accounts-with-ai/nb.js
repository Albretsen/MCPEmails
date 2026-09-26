const translation = {
  title: 'Slik håndterer du flere e-postkontoer med én AI-agent',
  description:
    'Kjør postkassene for jobb, privat og bijobb gjennom én AI-agent: hvordan den finner postkassene, hvordan du avgrenser en forespørsel, avsendernavn som forblir riktige, og godkjenning av sending per postkasse.',
  coverAlt:
    'Én AI-agent koblet til e-postkontoer for jobb, privat og bijobb med MCP Emails',
  content: `Nesten ingen har bare én postkasse. Du har en jobbadresse, en privat adresse og minst én til for en bijobb eller et domene du fortsatt eier. Hvert spørsmål som krysser to kontoer, blir et manuelt søk to steder.

Én AI-agent på tvers av alle sammen fjerner vekslingen, men bare hvis agenten vet hvilken postkasse som er hvilken, og svarene går ut fra riktig adresse.

**Hopp til:** [Oppdagelse](#agenten-finner-postkassene-selv) · [Avgrens én forespørsel](#avgrens-n-foresprsel-til-n-postkasse) · [Plangrenser](#der-plangrensene-treffer)

## Hvorfor én agent er bedre enn å bytte e-postklient

En e-postklient viser deg kontoer. Den svarer ikke på spørsmål. «Hvilken av kontoene mine fikk Stripe-kvitteringen?» er et søk på tvers av tre postkasser pluss en vurdering. En agent med tilgang til hver postkasse gjør det i én forespørsel, og du slipper å være den som ruter. Den andre gevinsten: ett sett med vaner, fordi de samme verktøyene ligger bak hver konto.

## Agenten finner postkassene selv

Du limer aldri inn en postkasse-ID i en prompt. Agenten kaller \`inbox_list\`, som returnerer hver postkasse nøkkelen din har lov til å bruke, hver med sin UUID, e-postadresse, visningsnavn, leverandør, valgfri tjenestemerkevare og et capabilities-objekt. Alle andre verktøy tar enten \`inbox_id\` (en UUID, eller en adresse) eller \`inbox\` (en adresse), fylt inn fra det resultatet.

To detaljer verdt å kjenne til:

- **Oppdagelse er gratis.** \`inbox_list\` er det ene verktøyet som ikke teller mot den månedlige handlingskvoten i Free, så en agent kan orientere seg på nytt uten kostnad.
- **Motstridende velgere avvises, de gjettes ikke.** Et kall som bærer en \`inbox_id\` for én postkasse og en \`inbox\`-adresse for en annen, blir avvist, og feilmeldingen navngir begge. Den vanlige årsaken er en utdatert ID som er dratt med fra tidligere i samtalen. Be agenten prøve på nytt med adressen alene.

## Avgrens én forespørsel til én postkasse

Nevn kontoen. Adresser fungerer overalt der en ID fungerer, så vanlig språk er nok:

> Bare i jane@acme.com: list alt ulest fra de siste to dagene og fortell meg hva som trenger et svar i dag. La de andre kontoene mine være i fred.

Du kan også håndheve avgrensningen utenfor prompten. I dashbordet har hver API-nøkkel en innstilling for **Postkassetilgang** (Inbox access): alle postkasser, eller en eksplisitt liste. En nøkkel som er begrenset til bijobb-postkassen, kan ikke lese de to andre, uansett hva en prompt sier.

## Fan-out er agenten som kaller én gang per postkasse

Dette er delen folk tar feil om: **ett kall når én postkasse.** Å liste, lese, søke, flytte og slette er alltid avgrenset til én enkelt postkasse, og det finnes ingen automatisk fan-out. Så «søk i alle kontoene mine» er agenten som kjører søket én gang per postkasse og slår sammen resultatene selv. Det fungerer godt, med tre konsekvenser:

- La den kalle \`inbox_list\` først, eller si hvor mange kontoer du har. Hvis den antar én, rapporterer den skråsikkert om én.
- Be om et sammenslått svar («én kombinert liste, merket med kontoen den kom fra»), ellers får du tre separate rapporter.
- Volumet vokser med antall postkasser. En triering av tre postkasser er minst tre fakturerbare handlinger, ikke én.

## Navn og avsenderidentitet

Ett felt gjør tre jobber. Hver postkasse har et visningsnavn: det er **Etiketten** (Label) i dashbordlisten din, \`display_name\` som agenten leser fra \`inbox_list\`, og navnet mottakerne ser i From-feltet, foran adressen.

«work2» er derfor et dårlig navn på to måter: agenten kan ikke se hva postkassen brukes til, og en eller annen klient kommer til å vise «work2» ved siden av adressen din. Bruk noe en fremmed kan lese, for eksempel «Jane Doe (Acme)» eller «Northside Studio». Sett det i dashbordet under postkassens **Avsendernavn** (Sender name), eller med \`signature_set\`, og les det tilbake med \`signature_get\`. Navn har en grense på 100 tegn.

Å sende fra et alias er snevrere enn folk venter:

- Din egen tilkoblede adresse fungerer alltid som From-verdi, hos alle leverandører.
- En **annen** adresse må være en verifisert Gmail Send As-identitet, oppført under \`sender_identities\` i den postkassens \`inbox_list\`-oppføring.
- Hos en leverandør som ikke er Gmail, blir en From-adresse som ikke er postkassens egen, avvist i stedet for stilltiende omskrevet.

Signaturer er også per postkasse: en formell på jobbadressen, ingen på den private. Se [e-postsignaturer for Claude](/blog/email-signatures-for-claude).

## Godkjenning av sending per postkasse

Godkjenning settes opp per postkasse. Hver postkasse har en innstilling for **Gjennomgang før sending** (Review before sending) med tre valg: send umiddelbart, vis et gjennomgangskort i AI-samtalen, eller gjennomgå kun i dashbordet.

Det er dette som gjør et blandet oppsett behagelig: la bijobb-postkassen sende umiddelbart, og hold tilbake hver eneste jobbsending til gjennomgang. I begge gjennomgangsmodusene blir e-posten klargjort, men ikke levert, og godkjenningen skjer bare i en innlogget nettleserøkt som eies av en eier eller administrator. Kortet i samtalen er en bekvemmelighet, ikke en tilgangsgrense. [Menneskelig godkjenning av e-post sendt av en AI-agent](/blog/approve-ai-agent-email-sends) går dypere inn i dette.

## Tre rutiner på tvers av postkasser som er verdt å stjele

**Én morgentriering på tvers av alt.** Be om én rangert liste, ikke en oppsummering per konto:

> Sjekk alle de tilkoblede postkassene mine. Gi meg én kombinert liste over hva som trenger et svar i dag, nyeste først, merket med kontoen det kom inn i. Ikke flytt, send eller slett noe.

[Spilleboken for innbokstriering](/blog/ai-agent-triage-summarize-inbox) har kriterier du kan lime inn i den prompten.

**Å finne en tråd når du har glemt hvilken konto den ligger i.**

> Finn fakturaen fra Hetzner fra august. Søk i hver tilkoblede postkasse, og fortell meg hvilken konto den ligger i og hva beløpet er.

**Å flytte en samtale mellom roller.** Når en privat kontakt blir en kunde, videresend tråden til firmapostkassen og få svaret skrevet fra firmaadressen. Be agenten bekrefte hvilken postkasse den sender fra først.

## Hva som endrer seg når du blander Gmail og IMAP

Blandede oppsett er det normale, og leverandørene er uenige om hva en mappe er.

- **Gmail har etiketter.** En flytting legger til en etikett og fjerner meldingen fra innboksen. Andre etiketter blir hengende ved, så en melding kan ligge flere steder.
- **IMAP har mapper.** En flytting er en flytting: meldingen forlater én mappe og havner i en annen.
- **Mappenavn er forskjellige.** Archive, All Mail, Spam, Junk og lokaliserte navn varierer per leverandør. La agenten kalle \`folder_list\` på postkassen den er i ferd med å røre.
- **Mappeavgrensning gjelder per postkasse.** Å begrense et søk til et sett med mapper gjelder inne i én postkasse, så et mappeavgrenset søk på tvers av kontoer er fortsatt ett kall per konto.

[Gmail-etiketter mot IMAP-mapper](/blog/gmail-labels-vs-imap-folders-ai-agents) forklarer hva «arkiver» egentlig betyr på hver side.

## Der plangrensene treffer

Tilkoblede postkasser er det planene prises på:

- **Free, $0.** Én tilkoblet postkasse. 150 fakturerbare e-posthandlinger per UTC-kalendermåned, der de første 7 dagene ikke telles. Den månedlige grensen gjelder arbeidsområder opprettet 2026-09-13 eller senere; arbeidsområder opprettet tidligere er unntatt.
- **Personal, $5 i måneden eller $48 i året.** Tre tilkoblede postkasser, ingen månedlig handlingsgrense, 2x burst-grense, e-poststøtte.
- **Pro, $15 i måneden eller $144 i året.** Ubegrenset antall tilkoblede postkasser, 5x burst-grense, lengre analysehistorikk.
- **Team, $79 i måneden eller $756 i året.** Ubegrenset antall medlemmer med roller, et eget arbeidsområde per kunde eller virksomhet, SSO (SAML/OIDC) og revisjonslogg, prioritert støtte.

En rutine på tvers av postkasser koster én handling per postkasse, så antallet postkasser driver volumet like mye som vanene dine gjør. Detaljer på [priser](/pricing).

## Vanlige spørsmål

**Hvordan vet agenten hvilken postkasse jeg mener?**
Fra \`inbox_list\`, som returnerer adressen og visningsnavnet til hver postkasse den har lov til å bruke. Nevn adressen i forespørselen din. En postkasse-ID og en adresse som er uenige, blir avvist, ikke gjettet.

**Går svarene ut fra riktig adresse?**
Ja, når du sender fra postkassen som eier adressen: hver postkasse sender gjennom sin egen leverandør, sitt eget visningsnavn og sin egen signatur. En annen From-adresse krever en verifisert Gmail Send As-identitet, og blir avvist hos andre leverandører.

**Kan jeg la agenten sende fritt fra én postkasse og holde tilbake en annen?**
Ja. Gjennomgang før sending er en innstilling per postkasse, så én postkasse kan sende umiddelbart mens en annen venter på godkjenningen din i en innlogget nettleser.

**Blir e-posten min fra alle disse kontoene lagret noe sted?**
Nei. Meldingsinnhold hentes live fra leverandøren din ved hver forespørsel og forkastes. Bare den krypterte leverandørlegitimasjonen beholdes. Se [sikkerhet](/security).

## Neste steg

[Start gratis](/signup), koble til den travleste postkassen din, og spør agenten hva som trenger et svar i dag. Legg til konto nummer to og tre når du vil ha ett svar i stedet for tre. [Dokumentasjonen](/docs) har den fulle verktøyreferansen, og [leverandørdetaljene](/docs/providers) dekker hva hver postkassetype støtter.`,
};

export default translation;
