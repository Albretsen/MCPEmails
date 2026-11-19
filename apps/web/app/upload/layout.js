import '../../styles/dashboard.css';
import '../../styles/theme.css';

/**
 * Shell for /upload, the page a `draft` 'upload_link' sends the user to. Like
 * /upgrade: outside app/[locale], no message provider; the copy is picked on
 * the server from ./copy.mjs and passed down as props.
 */
export default function UploadLayout({ children }) {
  return children;
}
