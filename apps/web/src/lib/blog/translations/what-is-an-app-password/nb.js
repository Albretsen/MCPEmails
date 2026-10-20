const translation = {
  title: 'Hva er et app-passord? Slik lager du et hos hver e-postleverandør',
  description:
    'Hva et app-passord er, hvorfor e-postapper og AI-koblinger trenger det, hvor du lager det hos Gmail, iCloud, Yahoo, AOL, Fastmail og Zoho, og hvordan du tilbakekaller det.',
  coverAlt: 'Et app-passord som kobler en e-postinnboks til en AI-agent gjennom MCPEmails',
  content: `Et **app-passord** er et eget passord som e-postleverandøren lager for én bestemt app, slik at appen kan logge inn på postkassen uten det vanlige kontopassordet ditt. Du lager det i sikkerhetsinnstillingene for kontoen, limer det inn i e-postprogrammet eller koblingen én gang, og sletter det når du vil stenge ute akkurat den appen. Det vanlige passordet ditt og alle andre apper fortsetter å virke.

Kobler du en postkasse til Thunderbird, Apple Mail eller en AI-agent gjennom en MCP-server som MCPEmails, er et manglende eller feil app-passord den vanligste grunnen til at innloggingen feiler. Denne veiledningen forklarer hva et app-passord er, hvorfor IMAP-klienter trenger det, hvor de store leverandørene har det, og hvordan du tilbakekaller det.

**Hopp til:** [Hvor du lager det](#hvor-du-lager-et-app-passord-hos-hver-leverandør) · [Slik tilbakekaller du det](#slik-tilbakekaller-du-et-app-passord) · [Sikkerhetsråd](#sikkerhetsråd) · [Vanlige spørsmål](#vanlige-spørsmål)

## Hva er et app-passord?

Et app-passord er en lang, tilfeldig generert legitimasjon som hører til e-postkontoen din, men som utstedes til én enkelt app. Tre ting skiller det fra passordet du skriver inn i nettposten:

- **Leverandøren lager det.** Du velger det ikke selv. Google lager en kode på 16 tegn, Apple viser en på formen \`abcd-efgh-ijkl-mnop\`, og de fleste leverandører viser den bare én gang.
- **Det brukes i stedet for passordet der det ikke går an å be om en ekstra faktor.** E-postprogrammer kobler seg til over IMAP (lesing) og SMTP (sending), og disse protokollene kan ikke vise en forespørsel om en andre faktor. Et app-passord er leverandørens måte å slippe inn slike klienter på uten å svekke innloggingen på nettet.
- **Det kan tilbakekalles alene.** Sletter du det, mister bare appen som brukte det tilgangen. Ingenting annet på kontoen endres.

Google beskriver det som en 16-sifret adgangskode som gir en app eller enhet tilgang til Google-kontoen din (i praksis består koden av 16 bokstaver). Apple kaller det samme et **appspesifikt passord**, Zoho et **application-specific password**, GMX og WEB.DE et **App-Passwort**. Alle navnene betyr det samme.

## Hvorfor IMAP-klienter og AI-koblinger trenger det

Mange e-postleverandører godtar ikke lenger det vanlige passordet ditt fra en tredjeparts e-postapp, særlig ikke når tofaktorautentisering er slått på. Et e-postprogram på datamaskinen, den innebygde e-postappen på telefonen og en server som leser e-post på dine vegne snakker alle IMAP og SMTP, og hos Google, Apple, Yahoo, AOL, Fastmail og Yandex er det et app-passord disse protokollene godtar.

En AI-kobling er i nøyaktig samme situasjon. Når Claude eller ChatGPT jobber med innboksen din gjennom [en MCP-e-postserver](/blog/what-is-an-mcp-email-server), logger ikke AI-en selv inn på postkassen. Det gjør MCP-serveren, over IMAP og SMTP, akkurat som Thunderbird ville gjort. For iCloud, Yahoo, AOL, Fastmail, Gmail og lignende leverandører trenger serveren derfor et app-passord, mens AI-klienten bare får et avgrenset token til serveren. [Veiledningen om OAuth og API-nøkler for e-posttilgang](/blog/oauth-vs-api-keys-ai-email-access) dekker det andre laget.

Den vanligste feilen er å lime inn passordet du bruker på leverandørens nettsted. Det er den vanligste grunnen til at en e-postapp eller AI-tilkobling ikke får logget inn. Genererte app-passord har en gjenkjennelig form, så tilkoblingsskjemaet i MCPEmails sjekker det du limer inn for Gmail, iCloud, Yahoo, Yandex og Fastmail, og advarer deg før forsøket når leverandøren, som ellers ville telt det som en mislykket innlogging. Er du sikker på at verdien stemmer, sender du den likevel ved å trykke **Koble til** en gang til.

## Hvor du lager et app-passord hos hver leverandør

Hvert punkt under forteller hvor du lager passordet og hva som må være slått på først. Den lenkede oppsettsiden for hver leverandør har IMAP- og SMTP-innstillingene og alle stegene.

- **Gmail og Google Workspace:** slå på totrinnsbekreftelse, og lag deretter et app-passord på \`myaccount.google.com/apppasswords\`. Koden er 16 bokstaver vist i fire grupper; mellomrom spiller ingen rolle. Google nevner tre tilfeller der valget mangler: enkelte jobb-, skole- eller andre organisasjonskontoer (på Workspace er det administratoren din som bestemmer), Avansert beskyttelse, og totrinnsbekreftelse som bare er satt opp med sikkerhetsnøkler. Oppsett: [Gmail](/connect/gmail), [Google Workspace](/connect/google-workspace).
- **iCloud Mail:** tofaktorautentisering er påkrevd. På \`account.apple.com\` åpner du **Pålogging og sikkerhet**, deretter **Appspesifikke passord**, og lager et. Du kan ha opptil 25 aktive samtidig. Oppsett: [iCloud Mail](/connect/icloud).
- **Yahoo Mail:** på Yahoos side for **Account Security**, under **External connections**, velger du **Create app password**, gir det et navn og genererer det. Oppsett: [Yahoo Mail](/connect/yahoo).
- **AOL Mail:** på AOLs side for **Account Security** velger du **Generate app password** (enkelte kontoer viser **Generate and manage app passwords**), deretter **Get Started**, gir det et navn og genererer det. AOL ber deg gjøre dette i en nettleser du har brukt til å logge inn på AOL Mail i flere dager, ikke i et privat vindu. Et app-passord fra Yahoo åpner ikke en AOL-postkasse, selv om de to kjører på samme plattform. Oppsett: [AOL Mail](/connect/aol).
- **verizon.net:** Verizon har lagt ned e-posttjenesten sin, og verizon.net-postkassene som finnes igjen er nå AOL-kontoer. Du lager derfor et app-passord hos **AOL** og logger inn med hele verizon.net-adressen. Oppsett: [verizon.net](/connect/verizon).
- **Fastmail:** gå til **Settings**, **Privacy & Security**, **Connected apps & API tokens**, **Manage app passwords and access**, **New app password**. Behold standard tilgangsnivå, **Mail, Contacts & Calendars**; et passord som bare gjelder Files, kan ikke logge inn på e-post. Fastmail kobles bare til med app-passord, og Fastmails Basic-abonnement kan ikke lage et. Oppsett: [Fastmail](/connect/fastmail).
- **Zoho Mail:** slå først på **IMAP Access** i Zoho Mail under **Settings**, **Mail Accounts**. Uten tofaktorautentisering fungerer Zoho-passordet ditt; med tofaktorautentisering, føderert innlogging (for eksempel innlogging med Google) eller SAML lager du et application-specific password i Zoho-kontoen og bruker det. Oppsett: [Zoho Mail](/connect/zoho).
- **Yandex Mail:** slå på IMAP under **Mail clients** i innstillingene for Yandex Mail, og åpne deretter **App passwords** på sikkerhetssiden på \`id.yandex.com\` og lag et for en e-postklient. Yandex viser det én gang. Oppsett: [Yandex Mail](/connect/yandex).
- **GMX:** slå først på **POP3/IMAP**-tilgang i e-postinnstillingene. Uten tofaktorautentisering fungerer det vanlige GMX-passordet ditt; med det lager du et App-Passwort under **Account verwalten**, **Login & Sicherheit**, **App-Passwörter (für externe Apps)**, **Neues App-Passwort erstellen**. GMX viser det én gang. Oppsett: [GMX](/connect/gmx).
- **WEB.DE:** samme som GMX: slå på **POP3/IMAP**-tilgang, og lag et App-Passwort på samme sted hvis tofaktorautentisering er på. Oppsett: [WEB.DE](/connect/web-de).
- **Outlook.com, Hotmail og Live:** ikke noe app-passord. Microsoft opplyser at Basic Authentication, passordinnloggingen som app-passord bygger på, ikke lenger er tilgjengelig for noen Outlook-konto etter 16. september 2024, så et app-passord kan ikke åpne postkassen. MCPEmails kobler i stedet disse kontoene til med **Logg på med Microsoft** gjennom Microsoft Graph. Oppsett: [Outlook.com](/connect/outlook); jobbkontoer dekkes i [veiledningen for Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

Alt annet, for eksempel en postkasse hos webhotellet ditt eller på ditt eget domene, følger samme mønster: lag et app-passord hvis leverandøren tilbyr det, bruk ellers passordet til postkassen, og skriv inn serverinnstillingene manuelt. [Siden for generisk IMAP](/connect/imap) og [hele listen over leverandører](/connect) dekker disse.

## Slik lager du et og kobler til innboksen

Stegene er de samme overalt, det er bare menynavnene som endres:

1. Slå på tofaktorautentisering på e-postkontoen hvis leverandøren krever det.
2. Åpne siden for app-passord nevnt over, gi passordet navn etter appen (for eksempel \`MCPEmails\`), og generer det.
3. Kopier det med en gang. De fleste leverandører viser det ikke igjen.
4. I MCPEmails åpner du **Innbokser**, deretter **Koble til innboks**, velger leverandøren og limer inn hele e-postadressen og app-passordet.
5. Legg til \`https://mcpemails.com/api/mcp\` i AI-klienten din. [Claude-veiledningen](/blog/connect-claude-to-email) og [ChatGPT-veiledningen](/blog/connect-chatgpt-to-email) går gjennom den delen.

Blir innloggingen fortsatt avvist, lister [veiledningen for IMAP-koblingen](/blog/claude-imap-connector) de andre vanlige årsakene: IMAP er slått av, feil regional server, eller et brukernavn som ikke er hele adressen.

## Slik tilbakekaller du et app-passord

Ved å tilbakekalle passordet stenger du ute én app uten å røre noe annet. Slett passordet på samme sted som du lagde det:

- **Google:** \`myaccount.google.com/apppasswords\`, deretter **Fjern** ved siden av oppføringen. Endrer du passordet til Google-kontoen, tilbakekalles også alle app-passord.
- **Apple:** **Pålogging og sikkerhet**, **Appspesifikke passord**, og fjern ett eller bruk **Tilbakekall alle**. Endrer eller tilbakestiller du passordet til Apple-kontoen, tilbakekalles alle automatisk.
- **Yahoo og AOL:** siden for **Account Security** (**External connections** hos Yahoo, **Generate and manage app passwords** hos AOL), deretter **Delete** ved siden av app-passordet. Å endre hovedpassordet tilbakekaller **ikke** app-passordene her, så du må slette oppføringen for å stenge ute en klient.
- **Fastmail, Zoho, Yandex, GMX, WEB.DE:** fjern det fra den samme listen over app-passord der du lagde det. Hos Yandex nullstilles også alle app-passord når du logger ut på alle enheter.

På MCPEmails-siden sletter **Koble fra innboks** i dashbordet det lagrede app-passordet sammen med tilkoblingen. Gjør du begge deler, er integrasjonen ryddig avsluttet: leverandøren slutter å godta passordet, og MCPEmails har det ikke lenger.

## Sikkerhetsråd

- **Lag ett per app.** Et eget app-passord med navn for hver klient gjør at du kan tilbakekalle ett uten å ødelegge for de andre, og listen i kontoen din viser hvem som fortsatt har tilgang.
- **Behandle det som et passord.** Et app-passord logger inn uten å spørre etter den andre faktoren, og det er hele poenget. Ikke lim det inn i en chat med en AI, et delt dokument eller en supporthenvendelse. I MCPEmails skrives det bare inn i tilkoblingsskjemaet.
- **Det gir som regel full e-posttilgang.** Hos de fleste leverandører kan et app-passord lese, sende og slette e-post, ikke bare en del av dette. Begrens heller hva AI-en kan gjøre i koblingen: MCPEmails lar deg godkjenne \`read:email\` uten \`send:email\`, og [veiledningen om trygg e-posttilgang](/blog/is-it-safe-to-give-ai-agent-email-access) dekker gjennomgang av utsendelser.
- **Vit hvor det lagres.** MCPEmails lagrer app-passordet kryptert med AES-256-GCM, dekrypterer det bare på serveren for å nå leverandøren din, og sender det aldri videre til AI-klienten. Meldingene dine hentes direkte og lagres ikke. [Hvorfor det er viktig](/blog/why-email-never-stored-matters).
- **Google anbefaler Logg på med Google der en app tilbyr det.** Google skriver at app-passord ikke anbefales og i de fleste tilfeller er unødvendige. De finnes for apper som ikke kan bruke den innloggingen, og det gjelder IMAP-klienter som bare tar imot et passord.

## Vanlige spørsmål

**Hva er et app-passord?**
Et app-passord er et tilfeldig generert passord som e-postleverandøren utsteder til én app eller enhet, for eksempel et e-postprogram eller en AI-kobling for e-post. Det lar appen logge inn over IMAP og SMTP uten hovedpassordet ditt, og du kan slette det når som helst for å tilbakekalle tilgangen for akkurat den appen.

**Er et app-passord det samme som e-postpassordet mitt?**
Nei. E-postpassordet er det du har valgt selv og skriver inn i nettposten. Et app-passord lages av leverandøren, brukes bare av én app, og hos de fleste leverandører fungerer ikke det vanlige passordet ditt i stedet for det.

**Hvorfor trenger jeg et app-passord for å koble e-post til en AI-agent?**
Fordi MCP-serveren som gir AI-en tilgang logger inn på postkassen over IMAP og SMTP, som et hvilket som helst e-postprogram, og de fleste leverandører godtar bare et app-passord der. Outlook.com er det viktigste unntaket: der kobler du til med Logg på med Microsoft.

**Utløper et app-passord?**
Det slutter å virke når du sletter det. Google og Apple tilbakekaller også alle app-passord når du endrer hovedpassordet til kontoen, mens Yahoo og AOL lar dem fortsette å virke etter et passordbytte til du sletter dem.

**Jeg har mistet app-passordet. Kan jeg se det igjen?**
Nei. De fleste leverandører viser det bare én gang. Slett det gamle, lag et nytt og lim det nye inn i appen. I MCPEmails åpner du innboksen og velger **Koble til på nytt**.

## Neste steg

[Opprett en gratis MCPEmails-konto](/signup), lag et app-passord hos leverandøren din og koble til innboksen. [Leverandøroversikten](/docs/providers) viser hva hver leverandør støtter når den er koblet til.`,
};

export default translation;
