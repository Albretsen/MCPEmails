import '../../../../styles/dashboard.css';

/**
 * Layout for /auth/fastmail/app-password.
 *
 * Imports dashboard.css so the app-password connection form has access to
 * the full design-system token set (buttons, inputs, color variables).
 *
 * A JS layout file is used here so TypeScript does not complain about the
 * side-effect CSS import (Next.js handles CSS at the bundler level).
 */
export default function AppPasswordLayout({ children }) {
  return children;
}
