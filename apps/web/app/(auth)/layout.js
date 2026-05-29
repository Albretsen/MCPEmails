import '../../styles/dashboard.css';

/**
 * Auth route group layout.
 *
 * Provides the centred dot-grid shell used by all auth screens:
 * /login, /signup, /forgot-password, /reset-password, /authorize.
 *
 * dashboard.css is imported here (in addition to the CSS already loaded by
 * the root layout) because auth forms use .field, .input, and .btn styles
 * defined there. No session check: middleware handles redirecting
 * already-authenticated users.
 */
export default function AuthLayout({ children }) {
  return children;
}
