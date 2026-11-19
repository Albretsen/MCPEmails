/**
 * Copy for /upload, the page an AI app sends the user to when it needs a file
 * for an email and cannot take it in the chat (`draft` 'upload_link',
 * supabase/functions/mcp-server/attachment-uploads.ts).
 *
 * A module next to the page rather than a `messages/` namespace, per
 * apps/web/CLAUDE.md. The browser's Accept-Language picks the language, as on
 * /upgrade; anything unrecognised is English. `{name}`, `{actual}` and
 * `{expected}` are filled in by the page.
 *
 * STYLE. Straight quotes, no em dashes, no angle brackets.
 */

export const UPLOAD_LOCALES = /** @type {const} */ (['en', 'nb', 'es', 'fr', 'de']);

const COPY = {
  en: {
    metaTitle: 'Upload a file',
    title: 'Upload a file for your email',
    asked: 'Your AI app asked for: {name}',
    choose: 'Choose file',
    drop: 'or drop it here',
    once: 'This link takes one file and works for two hours.',
    uploading: 'Uploading...',
    doneTitle: 'File uploaded',
    doneBody: 'Go back to your chat and say "uploaded". Your AI app can now attach the file.',
    expiredTitle: 'This upload link has expired',
    expiredBody: 'Ask your AI app for a new link.',
    invalidTitle: 'This upload link is incomplete',
    invalidBody: 'Open the whole link from your chat, or ask your AI app for a new one.',
    usedTitle: 'This link has already been used',
    usedBody: 'A file was already uploaded with it. Ask your AI app for a new link to upload another.',
    errorTitle: 'The upload did not finish',
    errorBody: 'Check your connection and try again.',
    tooBig: 'This file is over 10 MB, the limit for one email.',
  },
  nb: {
    metaTitle: 'Last opp en fil',
    title: 'Last opp en fil til e-posten',
    asked: 'AI-appen ba om: {name}',
    choose: 'Velg fil',
    drop: 'eller slipp den her',
    once: 'Lenken tar én fil og virker i to timer.',
    uploading: 'Laster opp...',
    doneTitle: 'Filen er lastet opp',
    doneBody: 'Gå tilbake til chatten og skriv "lastet opp". AI-appen kan nå legge ved filen.',
    expiredTitle: 'Denne opplastingslenken har utløpt',
    expiredBody: 'Be AI-appen om en ny lenke.',
    invalidTitle: 'Denne opplastingslenken er ufullstendig',
    invalidBody: 'Åpne hele lenken fra chatten, eller be AI-appen om en ny.',
    usedTitle: 'Denne lenken er allerede brukt',
    usedBody: 'Det er allerede lastet opp en fil med den. Be AI-appen om en ny lenke for å laste opp en til.',
    errorTitle: 'Opplastingen ble ikke fullført',
    errorBody: 'Sjekk tilkoblingen og prøv igjen.',
    tooBig: 'Filen er over 10 MB, som er grensen for én e-post.',
  },
  es: {
    metaTitle: 'Subir un archivo',
    title: 'Sube un archivo para tu correo',
    asked: 'Tu app de IA pidió: {name}',
    choose: 'Elegir archivo',
    drop: 'o suéltalo aquí',
    once: 'Este enlace admite un archivo y funciona durante dos horas.',
    uploading: 'Subiendo...',
    doneTitle: 'Archivo subido',
    doneBody: 'Vuelve a tu chat y escribe "subido". Tu app de IA ya puede adjuntar el archivo.',
    expiredTitle: 'Este enlace de subida ha caducado',
    expiredBody: 'Pide un enlace nuevo a tu app de IA.',
    invalidTitle: 'Este enlace de subida está incompleto',
    invalidBody: 'Abre el enlace completo desde tu chat o pide uno nuevo a tu app de IA.',
    usedTitle: 'Este enlace ya se ha usado',
    usedBody: 'Ya se subió un archivo con él. Pide un enlace nuevo a tu app de IA para subir otro.',
    errorTitle: 'La subida no se completó',
    errorBody: 'Comprueba tu conexión y vuelve a intentarlo.',
    tooBig: 'Este archivo supera los 10 MB, el límite para un correo.',
  },
  fr: {
    metaTitle: 'Envoyer un fichier',
    title: 'Envoyez un fichier pour votre e-mail',
    asked: 'Votre app d\'IA a demandé : {name}',
    choose: 'Choisir un fichier',
    drop: 'ou déposez-le ici',
    once: 'Ce lien accepte un seul fichier et reste valable deux heures.',
    uploading: 'Envoi en cours...',
    doneTitle: 'Fichier envoyé',
    doneBody: 'Revenez à votre chat et écrivez "envoyé". Votre app d\'IA peut maintenant joindre le fichier.',
    expiredTitle: 'Ce lien d\'envoi a expiré',
    expiredBody: 'Demandez un nouveau lien à votre app d\'IA.',
    invalidTitle: 'Ce lien d\'envoi est incomplet',
    invalidBody: 'Ouvrez le lien complet depuis votre chat, ou demandez-en un nouveau à votre app d\'IA.',
    usedTitle: 'Ce lien a déjà servi',
    usedBody: 'Un fichier a déjà été envoyé avec ce lien. Demandez-en un nouveau à votre app d\'IA pour en envoyer un autre.',
    errorTitle: 'L\'envoi n\'a pas abouti',
    errorBody: 'Vérifiez votre connexion et réessayez.',
    tooBig: 'Ce fichier dépasse 10 Mo, la limite pour un e-mail.',
  },
  de: {
    metaTitle: 'Datei hochladen',
    title: 'Laden Sie eine Datei für Ihre E-Mail hoch',
    asked: 'Ihre KI-App hat angefragt: {name}',
    choose: 'Datei auswählen',
    drop: 'oder hier ablegen',
    once: 'Dieser Link nimmt eine Datei an und gilt zwei Stunden.',
    uploading: 'Wird hochgeladen...',
    doneTitle: 'Datei hochgeladen',
    doneBody: 'Kehren Sie zu Ihrem Chat zurück und schreiben Sie "hochgeladen". Ihre KI-App kann die Datei jetzt anhängen.',
    expiredTitle: 'Dieser Upload-Link ist abgelaufen',
    expiredBody: 'Bitten Sie Ihre KI-App um einen neuen Link.',
    invalidTitle: 'Dieser Upload-Link ist unvollständig',
    invalidBody: 'Öffnen Sie den vollständigen Link aus Ihrem Chat oder bitten Sie Ihre KI-App um einen neuen.',
    usedTitle: 'Dieser Link wurde bereits verwendet',
    usedBody: 'Mit diesem Link wurde bereits eine Datei hochgeladen. Bitten Sie Ihre KI-App um einen neuen Link für eine weitere Datei.',
    errorTitle: 'Der Upload wurde nicht abgeschlossen',
    errorBody: 'Prüfen Sie Ihre Verbindung und versuchen Sie es erneut.',
    tooBig: 'Diese Datei ist größer als 10 MB, das Limit für eine E-Mail.',
  },
};

/**
 * The first supported language in an Accept-Language header, in its order.
 *
 * @param {string | null | undefined} header
 * @returns {(typeof UPLOAD_LOCALES)[number]}
 */
export function uploadLocale(header) {
  for (const part of String(header ?? '').split(',')) {
    const low = part.split(';')[0].trim().toLowerCase();
    if (low.startsWith('nb') || low.startsWith('no') || low.startsWith('nn')) return 'nb';
    if (low.startsWith('es')) return 'es';
    if (low.startsWith('fr')) return 'fr';
    if (low.startsWith('de')) return 'de';
    if (low.startsWith('en')) return 'en';
  }
  return 'en';
}

/** @param {string} locale */
export function uploadCopy(locale) {
  return COPY[locale] ?? COPY.en;
}

/** "1.2 MB" style sizes for the mismatch line. */
export function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Exported for the tests. */
export const UPLOAD_COPY = COPY;
