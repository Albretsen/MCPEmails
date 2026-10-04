/** Characters that are unsafe in a file name on some platform. */
export function safeFilename(name: string, fallback = "attachment"): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "_").replace(/^\.+/, "").trim();
  return cleaned.slice(0, 180) || fallback;
}

/** Hands a blob to the browser as a download with the given file name. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safeFilename(filename);
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // The download reads the blob after the click returns: revoke later.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
