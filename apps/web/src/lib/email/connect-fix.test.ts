// The connect fix table (auth-failure-help.ts connectFix): one case per
// (provider, reason / phase) row, plus the invariants that keep the table, the
// host presets and the message catalogue in step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONNECT_FIX_PROVIDERS,
  connectFailureContext,
  connectFix,
  findFixProvider,
  type ConnectFixInput,
} from './auth-failure-help.ts';
import { MAIL_HOST_PRESETS } from '../email-providers/host-presets.ts';
import { ACTIVATION_PROVIDERS } from '../analytics/activation-events.ts';

const webRoot = new URL('../../../', import.meta.url);
const LOCALES = ['en', 'nb', 'es', 'fr', 'de', 'zh'];
const messages = Object.fromEntries(
  LOCALES.map((locale) => [locale, JSON.parse(readFileSync(new URL(`messages/${locale}/dashboardChrome.json`, webRoot), 'utf8'))]),
);
const lookup = (locale: string, key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages[locale]);

function fix(over: Partial<ConnectFixInput>) {
  return connectFix({ card: 'generic', errorCode: 'auth_failed', reason: 'password_rejected', phase: 'authentication', ...over });
}
const keys = (value: ReturnType<typeof connectFix>) => value?.steps.map((line) => line.key) ?? [];
const linkIds = (value: ReturnType<typeof connectFix>) => value?.links.map((link) => link.id) ?? [];

// ── One case per row ───────────────────────────────────────────────────────

interface RowCase {
  name: string;
  input: Partial<ConnectFixInput>;
  row: string;
  provider?: string | null;
  steps?: string[];
  links?: string[];
  passwordProblem?: boolean;
  action?: 'test_again' | 'use_outlook';
  offerReceiveOnly?: boolean;
}

const ROWS: RowCase[] = [
  // Gmail
  {
    name: 'gmail card, account password used',
    input: { card: 'gmail', reason: 'account_password_used', email: 'a@gmail.com' },
    row: 'gmail_app_password', provider: 'gmail',
    steps: ['connect.fix.gmail.twoStep', 'connect.fix.gmail.create', 'connect.fix.gmail.paste', 'connect.fix.gmail.workspace'],
    links: ['gmail_two_step', 'gmail_app_passwords'], passwordProblem: true,
  },
  { name: 'gmail card, app password required', input: { card: 'gmail', reason: 'app_password_required' }, row: 'gmail_app_password', provider: 'gmail' },
  {
    name: 'gmail card, app password cut off in the paste',
    input: { card: 'gmail', reason: 'app_password_length' }, row: 'gmail_app_password', provider: 'gmail',
    steps: ['connect.appPasswordLengthDetail', 'connect.fix.gmail.twoStep', 'connect.fix.gmail.create', 'connect.fix.gmail.paste', 'connect.fix.gmail.workspace'],
  },
  {
    name: 'gmail card, IMAP disabled for Workspace',
    input: { card: 'gmail', reason: 'imap_disabled' }, row: 'gmail_imap_disabled', provider: 'gmail',
    steps: ['connect.fix.gmail.imapDisabled', 'connect.fix.gmail.imapDisabledAdmin'], links: ['gmail_workspace_imap'], passwordProblem: false,
  },
  {
    name: 'Gmail typed as Other (host imap.gmail.com, custom domain)',
    input: { email: 'me@company.example', imapHost: 'imap.gmail.com', reason: 'app_password_required' },
    row: 'gmail_app_password', provider: 'gmail',
  },
  // Yahoo and AOL
  {
    name: 'yahoo card, account password used',
    input: { card: 'yahoo', reason: 'account_password_used' }, row: 'yahoo_app_password', provider: 'yahoo',
    steps: ['connect.fix.appPassword.normalRejected', 'connect.fix.yahoo.create', 'connect.fix.appPassword.paste'], links: ['yahoo_app_passwords'],
  },
  { name: 'yahoo card, app password required', input: { card: 'yahoo', reason: 'app_password_required' }, row: 'yahoo_app_password', provider: 'yahoo' },
  { name: 'yahoo card, refused at SMTP', input: { card: 'yahoo', reason: 'app_password_required', phase: 'smtp_authentication', imapOk: true }, row: 'yahoo_app_password', provider: 'yahoo' },
  {
    name: 'AOL typed as Other on the generic imap.aol.com host',
    input: { email: 'x@aol.com', imapHost: 'imap.aol.com', reason: 'password_rejected' }, row: 'aol_password_rejected', provider: 'aol',
    steps: ['connect.fix.appPassword.normalRejected', 'connect.fix.aol.create', 'connect.fix.appPassword.paste'], links: ['aol_app_passwords'],
  },
  { name: 'AOL found by the host alone', input: { email: 'x@custom.example', imapHost: 'imap.aol.com' }, row: 'aol_password_rejected', provider: 'aol' },
  // iCloud
  {
    name: 'icloud card, account password used',
    input: { card: 'icloud', reason: 'account_password_used' }, row: 'icloud_app_password', provider: 'icloud',
    steps: ['connect.fix.appPassword.normalRejected', 'connect.fix.icloud.create', 'connect.fix.appPassword.paste'], links: ['icloud_app_passwords'],
  },
  { name: 'iCloud typed as Other', input: { email: 'a@me.com', imapHost: 'imap.mail.me.com', reason: 'app_password_required' }, row: 'icloud_app_password', provider: 'icloud' },
  // Known hosts typed as Other
  {
    name: 'IONOS', input: { email: 'a@shop.example', imapHost: 'imap.ionos.de' }, row: 'ionos_password_rejected', provider: 'ionos',
    steps: ['connect.fix.ionos.password', 'connect.authHelpWhereIonos', 'connect.fix.fullAddress'], links: ['ionos_help'],
  },
  {
    name: 'T-Online', input: { email: 'a@t-online.de', imapHost: 'secureimap.t-online.de' }, row: 't_online_password_rejected', provider: 't_online',
    steps: ['connect.fix.tOnline.password', 'connect.fix.tOnline.where'], links: ['t_online_help', 't_online_email_center'],
  },
  {
    name: 'IONOS US host: the European platform is named', input: { email: 'a@shop.example', imapHost: 'imap.ionos.com' }, row: 'ionos_password_rejected', provider: 'ionos',
    steps: ['connect.fix.ionos.password', 'connect.authHelpWhereIonos', 'connect.fix.fullAddress', 'connect.fix.ionos.platform'],
  },
  {
    name: 'IONOS Exchange', input: { email: 'a@shop.example', imapHost: 'exchange.ionos.eu' }, row: 'ionos_password_rejected', provider: 'ionos',
    steps: ['connect.fix.ionos.password', 'connect.authHelpWhereIonos', 'connect.fix.fullAddress'],
  },
  // Brazil
  {
    name: 'UOL Host', input: { email: 'a@empresa.example', imapHost: 'imap.uhserver.com' }, row: 'uol_host_password_rejected', provider: 'uol_host',
    steps: ['connect.fix.mailbox.password', 'connect.fix.fullAddress'], links: [],
  },
  {
    name: 'Locaweb', input: { email: 'a@empresa.example', imapHost: 'email-ssl.com.br' }, row: 'locaweb_password_rejected', provider: 'locaweb',
    steps: ['connect.fix.mailbox.password', 'connect.fix.fullAddress'], links: ['locaweb_help'],
  },
  { name: 'KingHost', input: { email: 'a@empresa.example', imapHost: 'imap.kinghost.net' }, row: 'kinghost_password_rejected', provider: 'kinghost', links: [] },
  { name: 'UOL', input: { email: 'a@uol.com.br', imapHost: 'imap.uol.com.br' }, row: 'uol_password_rejected', provider: 'uol', steps: ['connect.fix.uol.imap'] },
  { name: 'UOL, IMAP disabled', input: { email: 'a@uol.com.br', imapHost: 'imap.uol.com.br', reason: 'imap_disabled' }, row: 'uol_imap_disabled', provider: 'uol' },
  // Japan
  {
    name: 'Yahoo! JAPAN', input: { email: 'a@yahoo.co.jp', imapHost: 'imap.mail.yahoo.co.jp' }, row: 'yahoo_jp_password_rejected', provider: 'yahoo_jp',
    steps: ['connect.fix.yahooJapan.access', 'connect.fix.yahooJapan.password'], links: ['yahoo_jp_imap'],
  },
  { name: 'Yahoo! JAPAN, IMAP disabled', input: { email: 'a@yahoo.co.jp', imapHost: 'imap.mail.yahoo.co.jp', reason: 'imap_disabled' }, row: 'yahoo_jp_imap_disabled', provider: 'yahoo_jp', steps: ['connect.fix.yahooJapan.access'] },
  {
    name: 'docomo', input: { email: 'a@docomo.ne.jp', imapHost: 'imap.spmode.ne.jp' }, row: 'docomo_password_rejected', provider: 'docomo',
    steps: ['connect.fix.docomo.setting', 'connect.fix.docomo.login'], links: ['docomo_help'],
  },
  { name: 'SoftBank', input: { email: 'a@i.softbank.jp', imapHost: 'imap.softbank.jp' }, row: 'softbank_password_rejected', provider: 'softbank', links: ['softbank_help'] },
  { name: 'OCN', input: { email: 'a@ocn.ne.jp', imapHost: 'imap.ocn.ne.jp' }, row: 'ocn_password_rejected', provider: 'ocn', steps: ['connect.fix.mailbox.password', 'connect.fix.fullAddress'] },
  { name: 'BIGLOBE', input: { email: 'a@biglobe.ne.jp', imapHost: 'mail.biglobe.ne.jp' }, row: 'biglobe_password_rejected', provider: 'biglobe' },
  { name: '@nifty, IMAP disabled', input: { email: 'a@nifty.com', imapHost: 'imap.nifty.com', reason: 'imap_disabled' }, row: 'nifty_imap_disabled', provider: 'nifty', steps: ['connect.fix.nifty.imap'] },
  { name: 'So-net', input: { email: 'a@so-net.ne.jp', imapHost: 'imap.so-net.ne.jp' }, row: 'so_net_password_rejected', provider: 'so_net', steps: ['connect.fix.soNet.option', 'connect.fix.mailbox.password'] },
  { name: 'plala, IMAP disabled', input: { email: 'a@plala.or.jp', imapHost: 'imap.plala.or.jp', reason: 'imap_disabled' }, row: 'plala_imap_disabled', provider: 'plala', links: ['plala_imap'] },
  // Germany, Austria, Switzerland
  { name: 'Hetzner', input: { email: 'a@firma.example', imapHost: 'mail.your-server.de' }, row: 'hetzner_password_rejected', provider: 'hetzner' },
  { name: 'freenet', input: { email: 'a@freenet.de', imapHost: 'mx.freenet.de' }, row: 'freenet_password_rejected', provider: 'freenet', steps: ['connect.fix.freenet.imap', 'connect.fix.fullAddress'], links: ['freenet_imap'] },
  { name: 'Vodafone (Arcor address)', input: { email: 'a@arcor.de', imapHost: 'imap.vodafonemail.de' }, row: 'vodafone_password_rejected', provider: 'vodafone', links: ['vodafone_help'] },
  { name: 'Hostpoint', input: { email: 'a@firma.example', imapHost: 'imap.mail.hostpoint.ch' }, row: 'hostpoint_password_rejected', provider: 'hostpoint', links: ['hostpoint_help'] },
  { name: 'cyon', input: { email: 'a@firma.example', imapHost: 'mail.cyon.ch' }, row: 'cyon_password_rejected', provider: 'cyon' },
  { name: 'World4You', input: { email: 'a@firma.example', imapHost: 'imap.world4you.com' }, row: 'world4you_password_rejected', provider: 'world4you' },
  {
    name: 'mail.ru', input: { email: 'a@bk.ru', imapHost: 'imap.mail.ru' }, row: 'mail_ru_password_rejected', provider: 'mail_ru',
    steps: ['connect.fix.appPassword.normalRejected', 'connect.fix.mailRu.create', 'connect.fix.appPassword.paste'], links: ['mail_ru_help'],
  },
  { name: 'mail.ru, IMAP disabled', input: { email: 'a@mail.ru', imapHost: 'imap.mail.ru', reason: 'imap_disabled' }, row: 'mail_ru_imap_disabled', provider: 'mail_ru' },
  {
    name: 'QQ authorization code', input: { email: '123@qq.com', imapHost: 'imap.qq.com' }, row: 'qq_password_rejected', provider: 'qq',
    steps: ['connect.fix.qq.service', 'connect.fix.qq.code'], links: ['qq_help'],
  },
  { name: 'QQ, IMAP disabled', input: { email: '123@qq.com', imapHost: 'imap.qq.com', reason: 'imap_disabled' }, row: 'qq_imap_disabled', provider: 'qq' },
  {
    name: 'mail.com', input: { email: 'a@mail.com', imapHost: 'imap.mail.com' }, row: 'mail_com_password_rejected', provider: 'mail_com',
    steps: ['connect.fix.mailCom.imap', 'connect.fix.mailCom.twoFactor'], links: ['mail_com_imap', 'mail_com_app_passwords'],
  },
  { name: 'mail.com, IMAP disabled', input: { email: 'a@mail.com', imapHost: 'imap.mail.com', reason: 'imap_disabled' }, row: 'mail_com_imap_disabled', provider: 'mail_com' },
  {
    name: 'Infomaniak', input: { email: 'a@firm.example', imapHost: 'mail.infomaniak.com' }, row: 'infomaniak_password_rejected', provider: 'infomaniak',
    steps: ['connect.fix.infomaniak.password', 'connect.fix.appPassword.paste'], links: ['infomaniak_help'],
  },
  {
    name: 'Orange', input: { email: 'a@orange.fr', imapHost: 'imap.orange.fr' }, row: 'orange_password_rejected', provider: 'orange',
    steps: ['connect.fix.orange.imap', 'connect.fix.orange.password'], links: ['orange_imap'],
  },
  { name: 'Orange, IMAP disabled', input: { email: 'a@wanadoo.fr', imapHost: 'imap.orange.fr', reason: 'imap_disabled' }, row: 'orange_imap_disabled', provider: 'orange' },
  { name: 'Orange refusing the sign-in itself', input: { email: 'a@orange.fr', imapHost: 'imap.orange.fr', reason: 'provider_refused_signin' }, row: 'provider_refused', provider: 'orange', steps: ['connect.providerRefusedDetail'], passwordProblem: false },
  {
    name: 'Seznam', input: { email: 'a@seznam.cz', imapHost: 'imap.seznam.cz' }, row: 'seznam_password_rejected', provider: 'seznam',
    steps: ['connect.fix.seznam.password'], links: ['seznam_help'],
  },
  {
    name: 'GMX', input: { email: 'a@gmx.de', imapHost: 'imap.gmx.net' }, row: 'gmx_password_rejected', provider: 'gmx',
    steps: ['connect.fix.gmx.imap', 'connect.fix.gmx.twoFactor'], links: ['gmx_imap'],
  },
  { name: 'GMX, IMAP disabled', input: { email: 'a@gmx.net', imapHost: 'imap.gmx.net', reason: 'imap_disabled' }, row: 'gmx_imap_disabled', provider: 'gmx' },
  {
    name: 'WEB.DE', input: { email: 'a@web.de', imapHost: 'imap.web.de' }, row: 'web_de_password_rejected', provider: 'web_de',
    steps: ['connect.fix.gmx.imap', 'connect.fix.gmx.twoFactor'], links: ['web_de_imap'],
  },
  { name: 'WEB.DE, IMAP disabled', input: { email: 'a@web.de', imapHost: 'imap.web.de', reason: 'imap_disabled' }, row: 'web_de_imap_disabled', provider: 'web_de' },
  {
    name: 'Zoho typed as Other', input: { email: 'a@firm.example', imapHost: 'imappro.zoho.eu', reason: 'app_password_required' }, row: 'zoho_app_password', provider: 'zoho',
    steps: ['connect.fix.zoho.imap', 'connect.fix.zoho.twoFactor'], links: ['zoho_imap', 'zoho_app_passwords'],
  },
  { name: 'zoho card, IMAP disabled', input: { card: 'zoho', reason: 'imap_disabled' }, row: 'zoho_imap_disabled', provider: 'zoho', steps: ['connect.fix.zoho.imap'], links: ['zoho_imap'] },
  {
    name: 'yandex card, account password used', input: { card: 'yandex', reason: 'account_password_used' }, row: 'yandex_app_password', provider: 'yandex',
    steps: ['connect.fix.appPassword.normalRejected', 'connect.fix.yandex.create', 'connect.fix.yandex.imap'], links: ['yandex_app_passwords', 'yandex_imap'],
  },
  { name: 'yandex card, IMAP disabled', input: { card: 'yandex', reason: 'imap_disabled' }, row: 'yandex_imap_disabled', provider: 'yandex', steps: ['connect.fix.yandex.imap'] },
  // Italy, Czechia and Poland (2026-11-10)
  {
    name: 'Aruba domain mailbox, found by host', input: { email: 'a@firm.example', imapHost: 'imaps.aruba.it' }, row: 'aruba_password_rejected', provider: 'aruba',
    steps: ['connect.fix.aruba.password', 'connect.fix.fullAddress'], links: ['aruba_help'],
  },
  { name: 'Aruba free mailbox, found by address', input: { email: 'a@aruba.it', imapHost: 'imap.aruba.it' }, row: 'aruba_password_rejected', provider: 'aruba' },
  {
    name: 'Libero', input: { email: 'a@libero.it', imapHost: 'imapmail.libero.it' }, row: 'libero_password_rejected', provider: 'libero',
    steps: ['connect.fix.libero.password', 'connect.fix.fullAddress'], links: ['libero_app_passwords'],
  },
  { name: 'Virgilio is Libero', input: { email: 'a@virgilio.it', imapHost: 'in.virgilio.it' }, row: 'libero_password_rejected', provider: 'libero' },
  {
    name: 'TIM', input: { email: 'a@tim.it', imapHost: 'imap.tim.it' }, row: 'tim_password_rejected', provider: 'tim',
    steps: ['connect.fix.tim.line', 'connect.fix.fullAddress'], links: ['tim_help'],
  },
  { name: 'alice.it is TIM', input: { email: 'a@alice.it', imapHost: 'in.alice.it' }, row: 'tim_password_rejected', provider: 'tim' },
  {
    name: 'Tiscali', input: { email: 'a@tiscali.it', imapHost: 'imap.tiscali.it' }, row: 'tiscali_password_rejected', provider: 'tiscali',
    steps: ['connect.fix.tiscali.password', 'connect.fix.fullAddress'], links: ['tiscali_help'],
  },
  {
    name: 'Aruba PEC', input: { email: 'a@pec.it', imapHost: 'imaps.pec.aruba.it' }, row: 'aruba_pec_password_rejected', provider: 'aruba_pec',
    steps: ['connect.fix.arubaPec.password', 'connect.fix.fullAddress'], links: ['aruba_pec_app_passwords'],
  },
  { name: 'Aruba PEC on a custom domain, found by host', input: { email: 'a@pec.firm.example', imapHost: 'imaps.pec.aruba.it' }, row: 'aruba_pec_password_rejected', provider: 'aruba_pec' },
  {
    name: 'Legalmail', input: { email: 'a@legalmail.it', imapHost: 'mbox.cert.legalmail.it' }, row: 'legalmail_password_rejected', provider: 'legalmail',
    steps: ['connect.fix.legalmail.password'], links: ['legalmail_help'],
  },
  {
    name: 'Poste PEC wants its client password', input: { email: 'a@postecert.it', imapHost: 'mail.postecert.it', reason: 'app_password_required' }, row: 'postecert_app_password', provider: 'postecert',
    steps: ['connect.fix.appPassword.normalRejected', 'connect.fix.postecert.password', 'connect.fix.appPassword.paste'], links: ['postecert_app_passwords'],
  },
  {
    name: 'Centrum', input: { email: 'a@centrum.cz', imapHost: 'imap.centrum.cz' }, row: 'centrum_password_rejected', provider: 'centrum',
    steps: ['connect.fix.centrum.password', 'connect.fix.centrum.smtp', 'connect.fix.fullAddress'], links: ['centrum_help'],
  },
  { name: 'Volný is Centrum', input: { email: 'a@volny.cz', imapHost: 'imap.volny.cz' }, row: 'centrum_password_rejected', provider: 'centrum' },
  {
    name: 'WP Poczta', input: { email: 'a@wp.pl', imapHost: 'imap.wp.pl' }, row: 'wp_password_rejected', provider: 'wp',
    steps: ['connect.fix.wp.imap', 'connect.fix.wp.twoStep'], links: ['wp_imap'],
  },
  { name: 'WP Poczta, IMAP disabled', input: { email: 'a@wp.pl', imapHost: 'imap.wp.pl', reason: 'imap_disabled' }, row: 'wp_imap_disabled', provider: 'wp', steps: ['connect.fix.wp.imap'] },
  {
    name: 'o2.pl shares the WP steps with its own link', input: { email: 'a@o2.pl', imapHost: 'poczta.o2.pl' }, row: 'o2_pl_password_rejected', provider: 'o2_pl',
    steps: ['connect.fix.wp.imap', 'connect.fix.wp.twoStep'], links: ['o2_imap'],
  },
  {
    name: 'Onet', input: { email: 'a@onet.pl', imapHost: 'imap.poczta.onet.pl' }, row: 'onet_password_rejected', provider: 'onet',
    steps: ['connect.fix.onet.protocols', 'connect.fix.onet.appPassword'], links: ['onet_protocols'],
  },
  { name: 'Onet, IMAP disabled', input: { email: 'a@op.pl', imapHost: 'imap.poczta.onet.pl', reason: 'imap_disabled' }, row: 'onet_imap_disabled', provider: 'onet', steps: ['connect.fix.onet.protocols'] },
  {
    name: 'Interia', input: { email: 'a@interia.pl', imapHost: 'poczta.interia.pl' }, row: 'interia_password_rejected', provider: 'interia',
    steps: ['connect.fix.interia.program', 'connect.fix.interia.twoStep'], links: ['interia_params'],
  },
  { name: 'Interia, IMAP disabled', input: { email: 'a@poczta.fm', imapHost: 'poczta.interia.pl', reason: 'imap_disabled' }, row: 'interia_imap_disabled', provider: 'interia', steps: ['connect.fix.interia.program'] },
  // Web hosts (2026-11-11): the mailbox password with the full address, and the vendor page.
  { name: 'cyber_Folks on the customer\'s own server number', input: { email: 'a@firma.example', imapHost: 's20.cyber-folks.pl' }, row: 'cyber_folks_password_rejected', provider: 'cyber_folks', steps: ['connect.fix.mailbox.password', 'connect.fix.fullAddress'], links: ['cyber_folks_help'] },
  { name: 'TransIP', input: { email: 'a@bedrijf.example', imapHost: 'imap.transip.email' }, row: 'transip_password_rejected', provider: 'transip', links: ['transip_help'] },
  { name: 'Combell Basic mailbox', input: { email: 'a@bedrijf.example', imapHost: 'imap.mailprotect.be' }, row: 'combell_password_rejected', provider: 'combell', links: ['combell_help'] },
  { name: 'Websupport points at the GeoIP article', input: { email: 'a@firma.example', imapHost: 'imap.m1.websupport.sk' }, row: 'websupport_password_rejected', provider: 'websupport', links: ['websupport_geo'] },
  { name: 'Websupport.cz is Websupport', input: { email: 'a@firma.example', imapHost: 'imap.websupport.cz' }, row: 'websupport_password_rejected', provider: 'websupport' },
  { name: 'REG.RU hosting mail', input: { email: 'a@firma.example', imapHost: 'mail.hosting.reg.ru' }, row: 'reg_ru_password_rejected', provider: 'reg_ru', links: ['reg_ru_help'] },
  { name: 'StackMail, found by host or by the stackmail.com address', input: { email: 'a@stackmail.com', imapHost: 'imap.stackmail.com' }, row: 'stackmail_password_rejected', provider: 'stackmail', links: ['stackmail_help'] },
  { name: 'Arsys on serviciodecorreo.es', input: { email: 'a@empresa.example', imapHost: 'imap.serviciodecorreo.es' }, row: 'arsys_password_rejected', provider: 'arsys', links: ['arsys_help'] },
  // Microsoft 365 on the generic form
  {
    name: 'Office 365 host: switch to the Microsoft sign-in card',
    input: { email: 'a@firm.example', imapHost: 'outlook.office365.com', smtpHost: 'smtp.office365.com' },
    row: 'office365_use_outlook', provider: 'office365', steps: ['connect.fix.office365.useOutlook'], action: 'use_outlook', passwordProblem: false,
  },
  // Generic reasons with no provider steps
  { name: 'unknown host, IMAP disabled', input: { email: 'a@firm.example', imapHost: 'mail.firm.example', reason: 'imap_disabled' }, row: 'imap_disabled', provider: null, steps: ['connect.imapDisabledDetail'] },
  { name: 'unknown host, login name required', input: { email: 'a@firm.example', imapHost: 'mail.firm.example', reason: 'login_username_required' }, row: 'login_username', provider: null, steps: ['connect.loginNameDetail'] },
  {
    name: 'unknown own-domain host, plain rejection', input: { email: 'a@firm.example', imapHost: 'mail.firm.example' }, row: 'password_rejected', provider: null,
    steps: ['connect.authHelpOwnDomainPassword', 'connect.authHelpOwnDomainWhere', 'connect.authHelpTwoFactor'], passwordProblem: true,
  },
  { name: 'a HOST_HELP host (STRATO) keeps its own lines', input: { email: 'a@firm.example', imapHost: 'imap.strato.de' }, row: 'host_strato', provider: null, passwordProblem: true },
  { name: 'fastmail card keeps the generator link', input: { card: 'fastmail', reason: 'account_password_used', email: 'a@fastmail.com' }, row: 'app_password', provider: null, links: ['fastmail_app_passwords'] },
  // SMTP refused after IMAP passed, on a server with no provider steps
  {
    name: 'SMTP rejected after IMAP OK, generic both',
    input: { email: 'a@firm.example', imapHost: 'mail.firm.example', smtpHost: 'mail.firm.example', phase: 'smtp_authentication', imapOk: true, connectionMode: 'both' },
    row: 'smtp_rejected', provider: null, steps: ['connect.fix.smtp.readingOk', 'connect.fix.smtp.username', 'connect.fix.smtp.readOnly'],
    offerReceiveOnly: true, passwordProblem: false,
  },
  // Transport
  {
    name: 'tcp, relay not tried', input: { errorCode: 'connection_timeout', reason: null, phase: 'tcp', host: 'mail.firm.example', email: 'a@firm.example' },
    row: 'server_unreachable', steps: ['connect.fix.unreachable.tried', 'connect.fix.unreachable.check'], passwordProblem: false,
  },
  {
    name: 'tcp, relay retry failed too', input: { errorCode: 'connection_timeout', reason: null, phase: 'tcp', host: 'mail.school.example', email: 'a@school.example', relayFailed: true },
    row: 'server_blocks_us', steps: ['connect.fix.unreachable.tried', 'connect.fix.unreachable.blocked', 'connect.fix.unreachable.blockedNext'],
  },
  {
    name: 'greeting never came', input: { errorCode: 'imap_protocol_error', reason: null, phase: 'greeting', host: 'mail.firm.example', email: 'a@firm.example' },
    row: 'server_unreachable',
  },
  {
    name: 'smtp_tcp with both halves: reading only is offered', input: { errorCode: 'connection_refused', reason: null, phase: 'smtp_tcp', host: 'smtp.firm.example', email: 'a@firm.example', connectionMode: 'both' },
    row: 'server_unreachable', offerReceiveOnly: true, steps: ['connect.fix.unreachable.tried', 'connect.fix.unreachable.check', 'connect.fix.smtp.readOnly'],
  },
  {
    name: 'host typo: the provider host is suggested', input: { errorCode: 'host_not_found', reason: null, phase: 'tcp', host: 'imap.gmx.nt', email: 'a@gmx.net' },
    row: 'host_not_found', steps: ['connect.fix.unreachable.notFound', 'connect.fix.unreachable.suggest'],
  },
  {
    name: 'tls on IMAP', input: { errorCode: 'tls_handshake_failed', reason: null, phase: 'tls', email: 'a@firm.example' },
    row: 'tls', steps: ['connect.fix.tls.tried', 'connect.fix.tls.next'], passwordProblem: false,
  },
  { name: 'tls on SMTP, branded card', input: { card: 'gmail', errorCode: 'tls_handshake_failed', reason: null, phase: 'smtp_tls' }, row: 'tls', steps: ['connect.fix.tls.tried'] },
];

for (const c of ROWS) {
  test(`row: ${c.name}`, () => {
    const out = fix(c.input);
    assert.ok(out, 'a row applies');
    assert.equal(out.row, c.row);
    if (c.provider !== undefined) assert.equal(out.provider, c.provider);
    if (c.steps) assert.deepEqual(keys(out), c.steps);
    if (c.links) assert.deepEqual(linkIds(out), c.links);
    if (c.passwordProblem !== undefined) assert.equal(out.passwordProblem, c.passwordProblem);
    assert.equal(out.action, c.action ?? 'test_again');
    if (c.offerReceiveOnly !== undefined) assert.equal(out.offerReceiveOnly, c.offerReceiveOnly);
    assert.ok((ACTIVATION_PROVIDERS as readonly string[]).includes(out.analyticsProvider), out.analyticsProvider);
  });
}

test('every auth reason has a row on the generic form', () => {
  for (const reason of ['imap_disabled', 'app_password_required', 'account_password_used', 'app_password_length', 'provider_refused_signin', 'login_username_required', 'password_rejected']) {
    assert.ok(fix({ reason, email: 'a@firm.example', imapHost: 'mail.firm.example' }), reason);
  }
});

test('codes that are not about the mailbox get no fix row', () => {
  for (const code of ['session_expired', 'insufficient_role', 'inbox_limit_reached', 'port_not_allowed', 'microsoft_account_use_outlook', 'save_failed']) {
    assert.equal(fix({ errorCode: code }), null, code);
  }
  assert.equal(fix({ errorCode: null }), null);
});

test('the suggested host carries the whole documented transport and is not offered when it is the host tried', () => {
  const typo = fix({ errorCode: 'host_not_found', reason: null, phase: 'tcp', host: 'imap.gmx.nt', email: 'a@gmx.net' });
  assert.equal(typo?.suggestedHost?.host, 'imap.gmx.net');
  assert.equal(typo?.suggestedHost?.smtpPort, 465);
  const same = fix({ errorCode: 'connection_timeout', reason: null, phase: 'tcp', host: 'imap.gmx.net', email: 'a@gmx.net' });
  assert.equal(same?.suggestedHost, null);
  // The send half suggests the sending host.
  const smtp = fix({ errorCode: 'connection_timeout', reason: null, phase: 'smtp_tcp', host: 'smtp.gmx.example', email: 'a@gmx.net' });
  assert.equal(smtp?.suggestedHost?.host, 'mail.gmx.net');
  // A branded card has no host fields to fill.
  assert.equal(fix({ card: 'gmail', errorCode: 'connection_timeout', reason: null, phase: 'tcp', host: 'imap.gmail.com', email: 'a@gmail.com' })?.suggestedHost, null);
});

test('reading only is never offered on a branded card or a one-sided connection', () => {
  assert.equal(fix({ card: 'yahoo', errorCode: 'connection_refused', reason: null, phase: 'smtp_tcp' })?.offerReceiveOnly, false);
  assert.equal(fix({ errorCode: 'connection_refused', reason: null, phase: 'smtp_tcp', connectionMode: 'smtp' })?.offerReceiveOnly, false);
  assert.equal(fix({ phase: 'smtp_authentication', imapOk: true, connectionMode: 'imap', email: 'a@firm.example', imapHost: 'mail.firm.example' })?.offerReceiveOnly, false);
});

test('a host is never a password: the blocked sentence needs the relay to have failed', () => {
  const plain = fix({ errorCode: 'connection_timeout', reason: null, phase: 'tcp', host: 'mail.firm.example', email: 'a@firm.example', relayFailed: false });
  assert.equal(keys(plain).includes('connect.fix.unreachable.blocked'), false);
  const notFound = fix({ errorCode: 'host_not_found', reason: null, phase: 'tcp', host: 'mail.firm.example', email: 'a@firm.example', relayFailed: true });
  assert.equal(keys(notFound).includes('connect.fix.unreachable.blocked'), false, 'a name that does not resolve is not a block');
});

// ── The table, the presets and the catalogue agree ─────────────────────────

test('presets and the fix table give the same app-password link', () => {
  for (const entry of CONNECT_FIX_PROVIDERS) {
    for (const presetId of entry.presetIds) {
      const preset = MAIL_HOST_PRESETS.find((p) => p.id === presetId);
      if (!preset?.requiresAppPassword || !preset.appPasswordHelpUrl) continue;
      const urls = [...(entry.credential?.links ?? []), ...(entry.imapDisabled?.links ?? [])].map((l) => l.url);
      assert.ok(urls.includes(preset.appPasswordHelpUrl), `${entry.id}: ${preset.appPasswordHelpUrl} is in the table`);
    }
  }
  // And every fix provider that needs an app password is flagged in the presets.
  for (const id of ['gmail', 'yahoo', 'aol', 'icloud', 'mail-ru', 'qq', 't-online', 'infomaniak', 'zoho', 'yandex']) {
    assert.equal(MAIL_HOST_PRESETS.find((p) => p.id === id)?.requiresAppPassword, true, id);
  }
});

test('every preset a fix provider names exists, and every link is https', () => {
  const ids = new Set(MAIL_HOST_PRESETS.map((p) => p.id));
  for (const entry of CONNECT_FIX_PROVIDERS) {
    for (const presetId of entry.presetIds) assert.ok(ids.has(presetId), `${entry.id}: ${presetId}`);
    for (const link of [...(entry.credential?.links ?? []), ...(entry.imapDisabled?.links ?? [])]) {
      assert.ok(link.url.startsWith('https://'), link.url);
    }
  }
});

test('docomo points at the Username field, because its login is not the address', () => {
  assert.equal(fix({ email: 'a@docomo.ne.jp', imapHost: 'imap.spmode.ne.jp' })?.showsUsernameField, true);
  // Only on the generic form, the one with that field.
  assert.equal(fix({ email: 'a@ocn.ne.jp', imapHost: 'imap.ocn.ne.jp' })?.showsUsernameField, false);
});

test('the IONOS platform line is only for the US host', () => {
  for (const imapHost of ['imap.ionos.de', 'imap.ionos.co.uk', 'exchange.ionos.eu']) {
    assert.equal(keys(fix({ email: 'a@shop.example', imapHost })).includes('connect.fix.ionos.platform'), false, imapHost);
  }
  assert.equal(keys(fix({ email: 'a@shop.example', imapHost: 'smtp.ionos.com', smtpHost: 'smtp.ionos.com' })).includes('connect.fix.ionos.platform'), true);
});

test('the Yahoo card refusing a Yahoo! JAPAN address gets no fix row of its own', () => {
  assert.equal(fix({ card: 'yahoo', errorCode: 'yahoo_japan_use_generic', email: 'a@yahoo.co.jp' }), null);
});

test('the card a user clicked wins over what the address says', () => {
  assert.equal(findFixProvider({ card: 'yahoo', email: 'a@gmail.com' })?.id, 'yahoo');
  assert.equal(findFixProvider({ card: 'generic', email: 'a@gmail.com' })?.id, 'gmail');
  assert.equal(findFixProvider({ card: 'generic', email: 'a@firm.example', host: 'mail.firm.example' }), null);
});

test('every key a row can render exists in en, nb, es, fr and de, with no em dash or angle bracket', () => {
  const used = new Set<string>();
  const collect = (value: ReturnType<typeof connectFix>) => {
    for (const line of value?.steps ?? []) used.add(line.key);
    for (const link of value?.links ?? []) used.add(link.labelKey);
  };
  for (const c of ROWS) collect(fix(c.input));
  for (const entry of CONNECT_FIX_PROVIDERS) {
    for (const block of [entry.credential, entry.imapDisabled]) {
      for (const key of block?.steps ?? []) used.add(key);
      for (const link of block?.links ?? []) used.add(link.labelKey);
    }
  }
  for (const key of ['heading', 'testAgain', 'useOutlook', 'receiveOnly', 'useSuggestedHost', 'progressLogin', 'progressSending', 'progressSlow',
    'outlookConsent.line1', 'outlookConsent.line2', 'outlookConsent.line3', 'outlookCancelled.title', 'outlookCancelled.body', 'outlookCancelled.tryAgain',
    'done.title', 'done.body', 'done.bodyClient', 'done.openGuide', 'done.later']) {
    used.add(`connect.fix.${key}`);
  }
  for (const locale of ['en', 'nb', 'es', 'fr', 'de']) {
    for (const key of used) {
      const value = lookup(locale, key);
      assert.equal(typeof value, 'string', `${locale}: ${key}`);
      assert.equal(/[—<]/.test(value as string), false, `${locale}: ${key} has an em dash or <`);
    }
  }
});

test('the product name is written MCPEmails in every fix string', () => {
  for (const locale of LOCALES) {
    const text = JSON.stringify(lookup(locale, 'connect.fix'));
    assert.equal(/MCP Emails|Mcpemails|mcpemails(?!\.com)/.test(text), false, locale);
  }
});

// ── The route side: connectFailureContext ──────────────────────────────────

test('route context: host, phase and relay flags, nothing else', () => {
  assert.deepEqual(
    connectFailureContext({ host: 'Mail.Example.TEST.', phase: 'tcp', viaRelay: false, relayAlsoFailed: true }),
    { via_relay: false, relay_failed: true, host: 'mail.example.test', phase: 'tcp' },
  );
  assert.deepEqual(
    connectFailureContext({ host: 'smtp.example.test', phase: 'smtp_authentication', viaRelay: true, imapOk: true }),
    { via_relay: true, relay_failed: false, host: 'smtp.example.test', phase: 'smtp_authentication', imap_ok: true },
  );
});

test('route context: an address-shaped or odd host and an unknown phase are dropped, not echoed', () => {
  const out = connectFailureContext({ host: 'user@example.test', phase: 'NO [AUTH] user@example.test' });
  assert.equal('host' in out, false);
  assert.equal('phase' in out, false);
  assert.equal(JSON.stringify(out).includes('@'), false);
  assert.equal('host' in connectFailureContext({ host: 'mail example' }), false);
  assert.equal('host' in connectFailureContext({ host: '' }), false);
});
