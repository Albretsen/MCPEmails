/**
 * Production stand-in for one Homepage Lab variant. next.config.js aliases
 * every `home-lab-vNN` to this file on builds that are not staging, so no
 * variant is compiled into production. The lab routes 404 there anyway.
 */
export default function HomeLabVariantOff(): null {
  return null;
}
