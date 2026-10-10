// Nome do arquivo na biblioteca a partir do link. A página e o workflow usam
// esta mesma função, então os dois chegam sempre ao mesmo nome.
export function slug(link) {
  const url = new URL(link);
  const base = `${url.hostname.replace(/^www\./, "")}${url.pathname}`;
  return (
    base
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "pagina"
  );
}
