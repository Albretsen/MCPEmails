import { headers } from 'next/headers';
import UploadClient from './UploadClient';
import { uploadCopy, uploadLocale } from './copy.mjs';

/**
 * /upload: where the user drops a file their AI app asked for, when the app
 * cannot take it in the chat (`draft` 'upload_link'). The signed upload URL
 * is in the fragment, which the server never sees, so this page renders the
 * same for every visitor and the client component reads the rest.
 */

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const c = uploadCopy(uploadLocale((await headers()).get('accept-language')));
  return {
    title: c.metaTitle,
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  };
}

export default async function UploadPage() {
  const c = uploadCopy(uploadLocale((await headers()).get('accept-language')));
  return <UploadClient copy={c} supabaseOrigin={process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''} />;
}
