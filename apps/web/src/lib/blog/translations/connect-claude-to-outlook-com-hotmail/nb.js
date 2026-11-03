const translation = {
  title: 'Koble Claude til Hotmail og Outlook.com (personlige kontoer)',
  description:
    'Microsoft 365-koblingen i Claude godtar ikke personlige Microsoft-kontoer. Koble en Hotmail-, Outlook.com-, Live- eller MSN-innboks til Claude med Logg på med Microsoft og én URL til en egendefinert kobling.',
  coverAlt: 'Claude koblet til en personlig Outlook.com- eller Hotmail-innboks gjennom MCPEmails',
  content: `For å koble Claude til en personlig Outlook.com-, Hotmail-, Live- eller MSN-adresse legger du til postkassen i MCPEmails med **Koble til med Microsoft**, og legger deretter til én URL i Claude som en egendefinert kobling (custom connector). Claudes egen Microsoft 365-kobling krever en Microsoft-tenant for bedrifter, og Anthropic skriver at personlige Microsoft-kontoer ikke kan brukes med den. En egendefinert kobling har ikke det kravet, så en gammel hotmail.com-adresse fungerer på samme måte som en ny outlook.com-adresse.

Denne guiden gjelder personlige Microsoft-kontoer i Claude. Er e-posten din en jobb- eller skolekonto i Microsoft 365, les heller [guiden for Outlook og Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

## Hvorfor Microsoft 365-koblingen i Claude avviser personlige kontoer

Anthropics [hjelpeside for Microsoft 365-koblingen](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) stiller to krav før noen kan koble til:

- Kontoen må høre til en Microsoft Entra-tenant knyttet til et Microsoft Business-abonnement.
- En global administrator i den tenanten må godkjenne integrasjonen først.

Den samme siden sier at personlige Microsoft-kontoer, for eksempel @outlook.com- eller @hotmail.com-adresser, ikke kan brukes til å koble til. En personlig konto har ingen bedriftstenant og ingen administrator bak seg, så det finnes ingenting å godkjenne og ingen innstilling du kan endre for å få det til. Koblingen er laget for organisasjoner: den søker i SharePoint, OneDrive, Outlook og Teams, og den har bare lesetilgang til en administrator slår på skriveverktøyene.

Det er ikke noe galt med postkassen din. Claude trenger bare en annen vei inn til den.

## Dette trenger du

- En personlig Microsoft-konto med en Outlook-postkasse: en adresse på outlook.com, hotmail.com, live.com eller msn.com, også landsvarianter som hotmail.co.uk, outlook.de eller live.no.
- Claude på nett eller Claude Desktop. Anthropic tilbyr egendefinerte koblinger på alle Claude-abonnementer, også Free, som gir deg én egendefinert kobling.
- En MCPEmails-konto. [Start gratis](/signup) og la fanen stå åpen.

MCPEmails står mellom de to. Mot Claude snakker MCPEmails over Model Context Protocol, og mot Outlook.com-postkassen din går det gjennom Microsoft Graph.

## Steg 1: Koble til Outlook.com- eller Hotmail-innboksen

1. I MCPEmails-dashbordet går du til **Innbokser** og klikker **Koble til innboks**.
2. Velg **Outlook**, og klikk **Koble til med Microsoft**.
3. Logg på Microsofts egen side med Outlook.com-, Hotmail-, Live- eller MSN-adressen din, og fullfør totrinnsbekreftelsen hvis kontoen din bruker det.
4. Se gjennom tillatelsene og godkjenn. Microsoft ber om tillatelse til at MCPEmails kan lese og endre e-posten din, sende e-post som deg, beholde tilgangen og se grunnprofilen og e-postadressen din.

Du kommer tilbake til dashbordet med innboksen tilkoblet. For en personlig konto er ingen administrator involvert, og du skriver aldri inn Microsoft-passordet ditt i MCPEmails.

### Ikke bruk IMAP eller app-passord

Mange eldre guider ber deg lage et app-passord og fylle inn IMAP-innstillingene til Outlook. Det virker ikke lenger: Microsoft [sluttet å godta passordpålogging for Outlook-kontoer i e-postapper som ikke er fra Microsoft](https://support.microsoft.com/en-us/office/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-apps-c5d65390-9676-4763-b41f-d7986499a90d) 16. september 2024. Velger du **IMAP / SMTP** og skriver inn en Hotmail- eller Outlook.com-adresse, viser dashbordet en melding med knappen **Bruk Logg på med Microsoft**, som sender deg tilbake til Outlook-valget. På [siden med Outlook.com-innstillinger](/connect/outlook) finner du leverandørdetaljene samlet.

## Steg 2: Legg til MCPEmails i Claude som en egendefinert kobling

I claude.ai eller Claude Desktop:

1. Åpne **Customize → Connectors**.
2. Klikk **+ Add**, og deretter **Add custom connector**.
3. Gi den et navn, for eksempel MCPEmails, og lim inn denne URL-en:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Klikk **Continue**, behold autentiseringsinnstillingene Claude finner, og klikk **Add**.
5. Klikk **Connect**, logg på MCPEmails-kontoen din og godkjenn tillatelsene du vil at Claude skal ha, for eksempel \`read:email\` for å lese e-post og \`send:email\` for å sende.

For å bruke koblingen i en samtale klikker du **+** nede til venstre i meldingsfeltet, velger **Connectors** og slår på MCPEmails. Du trenger ingen API-nøkkel og ingen konfigurasjonsfil. På et Team- eller Enterprise-abonnement er det bare en eier som kan legge til en egendefinert kobling. Medlemmene finner den deretter under **Customize → Connectors** og klikker **Connect**. Hvis Claude stopper opp på et av disse skjermbildene, går [oppsettsiden for Claude](/docs/claude) gjennom de vanligste problemene.

## Steg 3: Be Claude om noe enkelt

Begynn med en forespørsel som bare leser e-post:

> Oppsummer de fem nyeste uleste e-postene i Hotmail-innboksen min, og si hvilke jeg bør svare på.

Claude bruker verktøyet \`email_read\` til å liste opp og åpne meldingene. Får du svar, virker tilkoblingen. Prøv så:

- «Finn ordrebekreftelsen jeg fikk forrige uke, og si når den skal leveres.»
- «Skriv et utkast til svar på den siste e-posten fra utleieren min, men ikke send det.»
- «Flytt alle nyhetsbrev fra denne måneden til en mappe som heter Lesestoff.»

Har du også Gmail, iCloud eller en jobbpostkasse, kobler du dem til på samme måte, og Claude ser alle sammen gjennom den samme koblingen. [Flere e-postkontoer i Claude og ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) forklarer hvordan Claude holder dem fra hverandre.

## Dette kan Claude gjøre med en Outlook.com-innboks

Når innboksen er tilkoblet, jobber Claude med de samme e-postverktøyene som for alle andre leverandører:

- Lese og søke i e-post.
- Sende, svare og videresende fra din egen adresse, med vedlegg.
- Lage og redigere utkast, og planlegge en sending til senere.
- Lage mapper, også undermapper, og flytte, kopiere og arkivere meldinger.
- Flagge meldinger og merke dem som lest eller ulest.
- Flytte meldinger til Slettede elementer eller slette dem permanent.
- Legge til signaturen du har satt for innboksen på hver melding Claude sender.

Outlook.com organiserer e-post i mapper, ikke etiketter, så Claude sorterer e-post ved å flytte den til en mappe. Én begrensning i Microsoft Graph er verdt å kjenne til: et tekstsøk kan ikke kombineres med filtrene for ulest, vedlegg, flagget eller dato. Når et søk inneholder tekst, brukes ikke disse filtrene, og resultatet forteller Claude hvilke som ble utelatt. Be om teksten først, og la Claude snevre inn resultatene etterpå.

MCPEmails sender ikke ny e-post til Claude av seg selv. Claude sjekker når du ber om det, og det passer fint til sortering og oppsummeringer.

## Lagres Outlook.com-e-posten min noe sted?

Nei. Hver gang Claude ber om en melding, henter MCPEmails den direkte fra Microsoft, sender den videre til Claude og forkaster den. For innboksen lagres OAuth-tokenet fra Microsoft-påloggingen din, kryptert, pluss de få opplysningene en funksjon du slår på trenger, for eksempel en planlagt melding som venter på å bli sendt. For å koble fra sletter du innboksen i MCPEmails, eller fjerner MCPEmails fra appene som har tilgang til Microsoft-kontoen din. [Hvorfor «e-post lagres aldri» betyr noe](/blog/why-email-never-stored-matters) forklarer modellen, og [er det trygt å gi en AI-agent tilgang til e-post?](/blog/is-it-safe-to-give-ai-agent-email-access) tar for seg hva du bør passe på, for eksempel instruksjoner som er gjemt inne i en e-post.

## Vanlige spørsmål

**Kan jeg koble Claude til Outlook.com eller Hotmail?**
Ja. Den innebygde Microsoft 365-koblingen i Claude støtter ikke personlige Microsoft-kontoer, men en egendefinert kobling gjør det. Koble adressen til MCPEmails med Koble til med Microsoft, legg til \`https://mcpemails.com/api/mcp\` i Claude under Customize → Connectors, så kan Claude lese, søke i, sende og organisere e-posten din på Outlook.com, Hotmail, Live eller MSN.

**Hvorfor avviser Microsoft 365-koblingen i Claude Hotmail-adressen min?**
Anthropics hjelpeside sier at koblingen trenger en Microsoft Entra-tenant knyttet til et Microsoft Business-abonnement og en global administrator som godkjenner den, og at personlige Microsoft-kontoer ikke kan brukes. En personlig konto har verken tenant eller administrator.

**Trenger jeg et app-passord eller IMAP-innstillinger?**
Nei. Personlige Microsoft-kontoer kobles til med Logg på med Microsoft og Microsoft Graph. Microsoft godtar ikke lenger passordpålogging fra e-postapper som ikke er fra Microsoft på disse kontoene, så et app-passord ville uansett ikke latt deg logge på.

**Fungerer det med en gammel Hotmail-adresse?**
Ja. Hotmail-, Live-, MSN- og Outlook.com-adresser hører til den samme e-posttjenesten Microsoft har for privatpersoner, så alle kobles til på samme måte. Hvis Microsoft-kontoen du logger på med, ikke har noen Outlook-postkasse, avviser MCPEmails tilkoblingen og sier fra om det.

**Fungerer det samme oppsettet i ChatGPT?**
Ja. URL-en til koblingen er den samme, og [koble ChatGPT til e-posten din](/blog/connect-chatgpt-to-email) går gjennom oppsettet på ChatGPT-siden.

## Neste steg

[Start gratis](/signup), koble til Outlook.com- eller Hotmail-innboksen din med Microsoft, legg til URL-en i Claude og be Claude oppsummere de uleste e-postene dine. For alle andre leverandører går [guiden for e-postoppsett i Claude](/blog/connect-claude-to-email) gjennom Gmail, iCloud, Fastmail og IMAP.`,
};

export default translation;
