// Copy for /docs/claude-email-arabic, the one Modern Standard Arabic page.
//
// It is a demand test, not a locale. `ar` is deliberately absent from
// routing.locales, the acquisition allowlists and the database, so the page is
// served under the English route and signup stays in English. The read-out is
// scripts/report-arabic-guide-test.sql.
//
// RULES FOR THIS FILE (src/lib/arabic-guide-content.test.mjs enforces them):
//   - Latin digits only (0-9), never Arabic-Indic ones.
//   - Menu labels are the exact English text on screen, in **bold**. Each one
//     was read on the real screen or in the code that renders it, on
//     2026-11-01: Claude's from claude.ai/customize/connectors and Anthropic's
//     article 11175166, MCPEmails' from messages/en/dashboardChrome.json
//     (connect.*) and messages/en/auth.json.
//   - Claude only. Whether ChatGPT Plus and Go can add a custom MCP server is
//     unsettled, so ChatGPT is not named here until someone has tested it.
//   - Any change to the Arabic goes back to the native reviewer before it ships.
//
// Only `code`, **bold** and [text](url) are understood by the page's renderer.

export const PATH = '/docs/claude-email-arabic';

export const DATE_MODIFIED = '2026-11-01';

export const MCP_URL = 'https://mcpemails.com/api/mcp';

export const copy = {
  meta: {
    title: 'كيفية ربط البريد الإلكتروني مع كلود: Outlook.com وIMAP',
    description:
      'دليل بالعربية لربط Outlook.com أو أي بريد يدعم IMAP أو عدة صناديق بريد مع كلود عبر موصّل مخصص واحد، مع أسماء القوائم كما تظهر على الشاشة بالإنجليزية.',
  },
  breadcrumb: 'ربط البريد مع كلود',
  eyebrow: 'دليل إعداد كلود',
  title: 'كيفية ربط بريدك الإلكتروني مع كلود',
  lead:
    'يشرح هذا الدليل ربط حساب Outlook.com الشخصي، أو أي بريد يدعم IMAP، أو عدة صناديق بريد معًا، مع كلود عبر موصّل مخصص واحد من MCPEmails. وتظهر أسماء القوائم في الخطوات بالإنجليزية كما تراها على الشاشة.',
  answer:
    'باختصار: أنشئ حسابًا في MCPEmails واربط صندوق بريدك من صفحة **Inboxes**. ثم افتح في كلود **Customize** ثم **Connectors**، واختر **Add** ثم **Add custom connector**، وألصق العنوان `https://mcpemails.com/api/mcp`، وسجّل الدخول إلى MCPEmails.',
  sections: [
    {
      id: 'before',
      h: 'قبل أن تبدأ',
      items: [
        'خطة كلود: تتيح الخطة المجانية موصّلًا مخصصًا واحدًا فقط، وتتيح خطتا Pro وMax إضافة ما تحتاج إليه. وفي خطتي Team وEnterprise، يضيف مالك المؤسسة الموصّل من **Organization settings** ثم **Connectors**، ثم يضغط كل عضو على **Connect**.',
        'خطة MCPEmails: يمكنك ربط صندوق بريد واحد مجانًا ودون بطاقة دفع. أما ربط عدة صناديق فيتطلب خطة مدفوعة، وتجد التفاصيل في [صفحة الأسعار](/pricing).',
        'اللغة: صفحة التسجيل ولوحة التحكم في MCPEmails بالإنجليزية حاليًا، لذلك نذكر أسماء الأزرار كما هي.',
      ],
    },
    {
      id: 'outlook',
      h: 'الخطوة 1: ربط Outlook.com',
      lead: 'تناسب هذه الطريقة عناوين Outlook.com وHotmail وLive الشخصية. ولا يقبل موصّل Microsoft 365 في كلود هذه الحسابات الشخصية، ولذلك تحتاج إلى موصّل مخصص.',
      ordered: true,
      items: [
        '[أنشئ حسابًا في MCPEmails](/signup)، ثم افتح **Inboxes** واضغط على **Connect inbox**.',
        'اختر **Outlook**، ثم اضغط على **Connect with Microsoft**.',
        'سجّل الدخول إلى حسابك في Microsoft ووافق على الأذونات المطلوبة. لن تحتاج إلى كلمة مرور للتطبيقات، ولن تكتب كلمة مرور Microsoft في MCPEmails.',
      ],
      note: 'حساب العمل أو الجامعة في Microsoft 365 يُربط بالطريقة نفسها، لكن قد يلزم أن يوافق مسؤول تقنية المعلومات مرة واحدة. راجع [دليل موافقة المسؤول](/docs/microsoft-365-admin-consent) (بالإنجليزية).',
    },
    {
      id: 'imap',
      h: 'أو: ربط بريد عبر IMAP',
      lead: 'تناسب هذه الطريقة بريد الشركة على استضافة خاصة وأي خدمة بريد تدعم IMAP وSMTP. جهّز إعدادات الخادم من مزوّد البريد قبل أن تبدأ.',
      ordered: true,
      items: [
        'في صفحة **Inboxes** اضغط على **Connect inbox**، ثم اختر **IMAP / SMTP**.',
        'اكتب عنوانك في **Email address**، ثم راجع **IMAP host** و**IMAP port** و**SMTP host** و**SMTP port**. وتستخدم معظم الخدمات المنفذ `993` للاستقبال والمنفذ `465` أو `587` للإرسال.',
        'اكتب كلمة المرور في **Password**. وإذا كان مزوّدك يتيح كلمات مرور للتطبيقات فاستخدم إحداها، لأنه يمكنك إلغاؤها دون تغيير كلمة مرور حسابك.',
        'إذا كان اسم الدخول يختلف عن عنوان البريد، فافتح **Advanced settings** واكتبه في **Username (optional)**.',
      ],
    },
    {
      id: 'claude',
      h: 'الخطوة 2: إضافة MCPEmails إلى كلود',
      lead: 'تكفي هذه الخطوة مرة واحدة، مهما كان عدد صناديق البريد. وتعمل في claude.ai وفي Claude Desktop.',
      ordered: true,
      items: [
        'افتح **Customize** ثم **Connectors**، واضغط على **Add** ثم **Add custom connector**.',
        'اكتب `MCPEmails` في حقل **Name**، وألصق `https://mcpemails.com/api/mcp` في حقل **MCP server URL**، ثم اضغط على **Continue**.',
        'أبقِ إعدادات تسجيل الدخول التي اكتشفها كلود كما هي، واضغط على **Continue**، ثم **Add**.',
        'سجّل الدخول إلى MCPEmails واختر مستوى الوصول: **Read-only** للقراءة فقط، أو **Standard** لإضافة المسودات والإرسال، أو **Full access** لإضافة الجدولة والمجلدات والحذف. وننصح بالبدء بمستوى **Read-only**.',
        'في المحادثة، اضغط على زر **+** أسفل مربع الكتابة، واختر **Connectors**، ثم فعّل MCPEmails.',
      ],
    },
    {
      id: 'several',
      h: 'استخدام عدة صناديق بريد في كلود',
      lead: 'لا تحتاج إلى موصّل لكل صندوق. يكفي موصّل MCPEmails واحد، ويرى كلود كل الصناديق المرتبطة بمساحة عملك.',
      items: [
        'كرّر **Connect inbox** لكل صندوق بريد. ويمكنك الجمع بين Outlook.com وIMAP في المساحة نفسها.',
        'لا تُضف الموصّل إلى كلود مرة أخرى، فالصناديق الجديدة تظهر عبر الموصّل نفسه.',
        'يمكنك أن تذكر العنوان في طلبك، مثل: «ابحث في بريد sales@»، حتى يعرف كلود الصندوق المقصود.',
      ],
    },
    {
      id: 'try',
      h: 'جرّب هذه الطلبات',
      prompts: [
        'باستخدام MCPEmails، اعرض صناديق البريد المرتبطة بحسابي.',
        'باستخدام MCPEmails، ابحث في كل صناديق بريدي عن الرسائل التي تحتاج إلى رد مني منذ يومين. لا ترسل شيئًا ولا تنقل أي رسالة.',
        'باستخدام MCPEmails، اكتب ردًا على أحدث رسالة في صندوق Outlook واحفظه كمسودة دون إرساله.',
      ],
    },
    {
      id: 'data',
      h: 'أين تمر بياناتك؟',
      items: [
        'تُحفظ قاعدة البيانات في ستوكهولم بالسويد، وفيها بيانات الحساب وبيانات الاتصال المشفرة.',
        'تعمل الدوال التي تتصل بصندوق بريدك في شرق الولايات المتحدة (US East). ويمر محتوى البريد عبرها مباشرة أثناء كل طلب، وتُفك فيها بيانات الاتصال خلال الطلب.',
        'يُجلب البريد من مزوّدك عند كل طلب ولا يُحفظ على خوادمنا. وتجد التفاصيل في [سياسة الخصوصية](/privacy) (بالإنجليزية).',
      ],
    },
  ],
  cta: {
    title: 'ابدأ بصندوق بريد واحد مجانًا',
    sub: 'دون بطاقة دفع. صفحة التسجيل بالإنجليزية.',
    button: 'أنشئ حسابًا',
  },
};
