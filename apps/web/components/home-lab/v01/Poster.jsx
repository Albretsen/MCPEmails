/**
 * A clip's still frame as a lazy <picture>: AVIF first, WebP after, and the
 * phone-width frame under 768 px when there is one. Used instead of the
 * video `poster` attribute, which the browser fetches eagerly and only as one
 * file. Decorative: the clip around it carries the description.
 */
export default function Poster({ poster, className }) {
  const { base, width, height, mobile } = poster;
  return (
    <picture>
      {mobile && <source media="(max-width: 767px)" type="image/avif" srcSet={`${mobile.base}.avif`} width={mobile.width} height={mobile.height} />}
      {mobile && <source media="(max-width: 767px)" type="image/webp" srcSet={`${mobile.base}.webp`} width={mobile.width} height={mobile.height} />}
      <source type="image/avif" srcSet={`${base}.avif`} width={width} height={height} />
      <img className={className} src={`${base}.webp`} width={width} height={height} alt="" loading="lazy" decoding="async" />
    </picture>
  );
}
