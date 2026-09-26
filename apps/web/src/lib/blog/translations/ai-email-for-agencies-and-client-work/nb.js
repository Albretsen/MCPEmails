const translation = {
  title: 'E-post og AI for byråer: én agent på tvers av alle kundepostkasser',
  description:
    'Slik gir et byrå eller en frilanser en AI-agent tilgang til flere kundepostkasser uten å blande kundene: ett arbeidsområde per kunde, avgrensede nøkler, lesetilgang først og en godkjenning før hver utsending.',
  coverAlt:
    'Én AI-agent som jobber på tvers av adskilte kundepostkasser med avgrenset tilgang, MCP Emails',
  content: `Driver du e-post for mer enn én kunde, lever du med én regel: ingenting fra kunde A skal dukke opp i en tråd hos kunde B. En AI-agent endrer ikke regelen, den gjør det bare lettere å bryte den. Én agent med én legitimasjon som når hver eneste postkasse du forvalter, er én uforsiktig instruksjon unna å sitere feil faktura til feil person.

Tre feil er verdt å designe mot: **lekkasje mellom kunder**, der en for vid legitimasjon lar et søk treffe feil postkasse; **konsulenten som slutter**, som fortsatt har en fungerende API-nøkkel på maskinen sin; og **utsendingen ingen leste**, der en agent svarer kundens kunde høflig og feil. Bygger du skillet inn i selve tilgangen, kan ikke agenten krysse en grense selv når en instruksjon ber den om det.

**Hopp til:** [Ett arbeidsområde per kunde](#ett-arbeidsomrde-per-kunde) · [Avgrensede API-nøkler](#avgrensede-api-nkler-per-oppdrag) · [Godkjenning før utsending](#godkjenning-fr-utsending)

## Ett arbeidsområde per kunde

Arbeidsområdet er enheten som skiller. Postkasser, medlemmer, API-nøkler og aktivitet lever inne i ett, og grensen håndheves i databasen med sikkerhet på radnivå, ikke med forsiktig filtrering i applikasjonskoden. En nøkkel utstedt i Acme-arbeidsområdet kan ikke lese en postkasse hos Bolt, uansett hva instruksjonen sier.

Mer enn ett arbeidsområde er en **Team**-funksjon ($79/md., $756/år), som også gir ubegrenset antall medlemmer med roller, SSO (SAML / OIDC), revisjonslogg og prioritert støtte. Abonnementet henger på kontoen din og ikke på ett arbeidsområde, så ett Team-abonnement dekker alle kundearbeidsområdene du oppretter. Gi hvert av dem kundens navn, koble bare den kundens postkasser inn i det, og bytt mellom dem i sidemenyen i dashbordet.

Under Team er planene for én person i ett arbeidsområde: **Pro** ($15/md., $144/år) kobler til ubegrenset antall postkasser, **Personal** ($5/md.) tre, **Free** én. Billigere, og alle postkassene deler samme skadeomfang. Se [priser](/pricing) og [leverandørmatrisen](/docs/providers).

## Medlemmer og roller

Fire roller: **owner** (eier), **admin**, **member** og **viewer**. Bare eieren kan endre roller. Admins kan invitere og fjerne medlemmer, men ikke fjerne en annen admin. Viewers har kun lesetilgang, og det håndheves også i legitimasjonslaget: en nøkkel som holdes av en viewer kan bare bære \`read:email\` og \`search:email\`.

Å legge til folk i det hele tatt er en Team-funksjon, siden Free, Personal og Pro er planer for én person. Oppsettet som fungerer: kundeansvarlig for en kunde er admin i den kundens arbeidsområde og medlem i ingen andre, en junior som gjør triagering er viewer i det ene arbeidsområdet vedkommende jobber i, og ingen andre enn du har en innlogging som spenner over hele kundeporteføljen.

## Avgrensede API-nøkler per oppdrag

En API-nøkkel er det agenten bruker når klientverktøyet ikke snakker OAuth. To knapper snevrer den inn. Vri på begge.

**Tilganger.** En nøkkel bærer en eksplisitt liste fra dette vokabularet: \`read:email\`, \`search:email\`, \`send:email\`, \`manage:folders\`, \`delete:email\`, \`manage:drafts\`, \`manage:contacts\`, \`schedule:email\`, \`manage:automations\`. En triageringsnøkkel trenger bare \`read:email\`. Behandle \`manage:automations\` som den sterkeste av dem: en automasjon fortsetter å handle når ingen ser på.

**Postkasser.** En nøkkel når enten alle postkasser i arbeidsområdet, også de du kobler til senere, eller er begrenset til en eksplisitt liste. I kundearbeid begrenser du den.

Utsted én nøkkel per oppdrag eller per automasjon, navngitt etter jobben, slik at det å trekke den tilbake blir en beslutning om den jobben og ikke om hele oppsettet ditt. Nøkkelen i klartekst vises én gang, fordi bare en SHA-256-hash lagres.

Snakker klientverktøyet OAuth, slik Claude og de fleste MCP-klienter gjør, bruk heller det og legg til endepunktet:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

Samtykkeskjermen tilbyr en lesetilgang, en standard og en full tilgang, pluss et valg per tilgang. [OAuth mot API-nøkler](/blog/oauth-vs-api-keys-ai-email-access) forklarer hva du bør velge.

## Lesetilgang først, sending senere

Start hvert oppdrag med bare lesetilgang. En agent som kan lese, søke og oppsummere dekker allerede triagering, rapportering og "hva lovte vi dem i mars", som er mesteparten av verdien.

> Oppsummer ulest e-post i support-postkassen til Acme fra de to siste virkedagene. Grupper den i: må besvares i dag, venter på kunden, og støy. Ikke send, flytt eller slett noe.

Legg til kapasitet én tilgang av gangen, når en oppgave faktisk trenger den. Å gi for lite er reparerbart: et kall som mangler en tilgang får et tydelig svar om utilstrekkelig tilgang, så klienten kan be om akkurat den ene tilgangen og prøve igjen.

## Godkjenning før utsending

For alt som når kundens kunde, slår du på sendegjennomgang. Det er en innstilling per postkasse med tre moduser: send umiddelbart, et gjennomgangskort i AI-samtalen, eller gjennomgang bare i dashbordet.

I begge gjennomgangsmodusene er e-posten klargjort, men ikke levert, og godkjenning skjer bare ett sted: en innlogget nettleserøkt som tilhører en eier eller admin i arbeidsområdet. Assistenten har ingen nettleserøkt og kan derfor ikke godkjenne sin egen utsending. Den kan avvise en, som er den trygge retningen. Gjennomgangskortet er en bekvemmelighet, ikke en tilgangsgrense.

Gjennomgangsskjermen viser avsender, mottakerne i Til og Kopi, et antall blindkopimottakere, emnet, vedleggene og teksten, og HTML vises som kildekode i stedet for å gjengis. En ventende forespørsel utløper etter 24 timer. Sperren virker på alle planer, også Free. Mer i [menneskelig godkjenning av e-post fra en AI-agent](/blog/approve-ai-agent-email-sends).

## Delte postkasser som support@ og billing@

Delte adresser er helt vanlige postkasser her. Koble til support@ eller billing@ med et apppassord fra leverandøren, inne i arbeidsområdet til kunden som eier dem. Avsendernavnet er en innstilling per postkasse, så svar går ut som "Acme Support" og ikke som deg.

Agenten finner postkasser med \`inbox_list\` og henvender seg til dem ved navn, så du limer aldri inn postkasse-ID-er i en instruksjon. Derfra er settet lite: \`email_read\` og \`email_compose\`, \`email_organize\` og \`email_search_and_move\` til triagering, og \`draft\` og \`schedule\` til alt som bør vente på et menneske.

Sett én forventning tidlig: MCP Emails spør, den blir ikke varslet. Agenten sjekker ny e-post når du ber den om det, eller når en planlagt automasjon kjører, så "vi svarer innen 60 sekunder" er ikke et løfte denne arkitekturen gir.

## Overlevering og avslutning av tilgang

Øv på dette før du trenger det. Hvert punkt er én handling i dashbordet.

- **Trekk tilbake en nøkkel.** Den slutter å virke umiddelbart, overalt der den var limt inn.
- **Fjern et medlem.** Det trekker også tilbake API-nøklene vedkommende opprettet i arbeidsområdet, og den samme opprydningen skjer når noen forlater det selv.
- **Degrader til viewer.** Degraderingen trekker tilbake nøkler som bærer mer enn lesetilgang, i stedet for stille å svekke en legitimasjon noen fortsatt stoler på.
- **Koble fra postkassen.** Den lagrede legitimasjonen er den eneste postkassedataen som noen gang beholdes, og frakobling fjerner den.
- **Trekk tilbake hos leverandøren også.** Be kunden slette apppassordet eller trekke tilbake Google-tilgangen. Den veien går ikke via deg, og det er nettopp derfor den beroliger.

Det finnes ingen overføring av eierskap, så du kan ikke gi bort et arbeidsområde når et prosjekt avsluttes. En kunde som tar e-posten inn i eget hus, oppretter sin egen konto og kobler til sine egne postkasser.

## Hva du kan og ikke kan love en kunde

Påstander du trygt kan skrive i en avtale:

- Meldingsinnhold lagres aldri. Det hentes live fra kundens leverandør ved hver forespørsel og forkastes etterpå.
- Den eneste postkassedataen som beholdes, er leverandørlegitimasjonen, kryptert i ro med AES-256-GCM og med nøkkelen oppbevart separat.
- Aktivitet logges kun som metadata: verktøynavn, postkasse, tidsstempel og status, aldri innhold.
- Ingen AI-leverandør er underleverandør. MCP Emails sender verken e-posten din til en egen modell eller trener på den. Underleverandørene er Supabase, Vercel og Stripe.
- Det ene unntaket fra "lagres aldri" er en melding som planlegges for senere, som holdes kryptert fram til sendetidspunktet.

Ikke lov at instruksjonsinjeksjon er løst. Den er begrenset, ikke løst, og nettopp derfor finnes lesetilgangsnøkler, begrensede postkasser og godkjenningssperren. Ikke lov øyeblikkelig reaksjon, og ikke lov sertifiseringer produktet aldri har hevdet. Send kundens sikkerhetsansvarlige til [/security](/security) og skriv avtalen slik at den passer til den siden, ikke foran den. Koden er offentlig og kan driftes selv, noe som besvarer en sikkerhetsgjennomgang bedre enn et løfte.

## Ofte stilte spørsmål

**Trenger jeg en egen MCP Emails-konto per kunde?**  
Nei. Én konto, ett Team-abonnement og ett arbeidsområde per kunde. Abonnementet følger brukeren din, så hvert arbeidsområde arver planen.

**Kan én kunde se en annen kundes e-post?**  
Ikke hvis hver kundes postkasser lever i sitt eget arbeidsområde. Skillet håndheves med sikkerhet på radnivå, og en nøkkel utstedt i ett arbeidsområde kan ikke lese postkassene i et annet.

**Hva skjer den dagen en konsulent slutter?**  
Fjern vedkommende fra arbeidsområdet, noe som i samme handling trekker tilbake nøklene som ble opprettet der. Skal personen bli, men slutte å skrive, degraderer du til viewer.

**Fungerer dette for en kunde på Microsoft 365?**  
Ja. En Microsoft 365-postkasse kobles til med Logg inn med Microsoft, uten app-passord. Mange organisasjoner krever at en IT-ansvarlig godkjenner appen én gang for hele organisasjonen før noen kan koble til; dashbordet gir deg en lenke du sender til kundens IT-ansvarlig, og deretter kobles hver postkasse til som vanlig.

## Neste steg

[Opprett en gratis konto](/signup), koble til én kundepostkasse med bare lesetilgang, og kjør en triageringsinstruksjon før du rører noe annet. Når skillet betyr noe, gå til Team på [prissiden](/pricing). [Dokumentasjonen](/docs) har den fullstendige referansen over verktøy og tilganger, og [/security](/security) er siden du gir til kundens sikkerhetsansvarlige.`,
};

export default translation;
