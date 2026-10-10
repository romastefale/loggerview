// Extrai a publicação de uma página e grava na biblioteca em .md, .html e .pdf.
// Um caminho só: o Chromium carrega a página (com JavaScript), o Readability
// tira o conteúdo, o Turndown gera o .md e o próprio Chromium imprime o PDF.
// Qualquer falha encerra com um erro ::error:: que a página mostra no alerta.
// Não há como saber se o site mudou: cada pedido é uma versão nova, guardada ao
// lado das anteriores em biblioteca/<site>/<versão>.{md,html,pdf}.
// Uso: node scripts/extrair.mjs <link> [versão]
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import TurndownService from "turndown";
import { slug } from "../slug.js";

const READABILITY = createRequire(import.meta.url).resolve("@mozilla/readability/Readability.js");
const PASTA = "biblioteca";
// Chrome comum; o padrão do Playwright se anuncia como "HeadlessChrome" e alguns sites recusam.
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function falha(motivo) {
  console.log(`::error::${motivo}`);
  process.exit(1);
}

const link = process.argv[2] ?? "";
let alvo;
try {
  alvo = new URL(link.trim());
} catch {
  falha("Esse link não é válido.");
}
if (alvo.protocol !== "http:" && alvo.protocol !== "https:") falha("O link precisa começar com http ou https.");

const pasta = `${PASTA}/${slug(alvo.href)}`;
const versao = process.argv[3]?.trim() || novaVersao();
if (!/^[a-z0-9-]+$/.test(versao)) falha("Versão inválida.");
const browser = await chromium.launch();
try {
  // bypassCSP: sites com Content-Security-Policy (o GitHub, por exemplo) recusam o
  // script do Readability que injetamos; isso só libera o nosso script, o conteúdo é o mesmo.
  const contexto = await browser.newContext({ userAgent: UA, locale: "pt-BR", bypassCSP: true });
  const page = await contexto.newPage();

  let resposta;
  try {
    resposta = await page.goto(alvo.href, { waitUntil: "load", timeout: 90_000 });
  } catch (erro) {
    falha(`Não consegui abrir o site: ${erro.message.split("\n")[0]}`);
  }
  if (!resposta) falha("O site não respondeu.");
  if (resposta.status() >= 400) falha(`O site respondeu ${resposta.status()}.`);
  // Espera o JavaScript da página terminar de buscar o conteúdo. Há sites que
  // nunca param de conversar com o servidor; depois de 30 s seguimos com o que carregou.
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

  await page.addScriptTag({ path: READABILITY });
  const artigo = await page.evaluate(() => {
    // O Readability altera o documento que recebe; trabalha numa cópia.
    // keepClasses: as classes guardam a linguagem dos blocos de código (language-js etc.).
    const lido = new Readability(document.cloneNode(true), { keepClasses: true }).parse();
    return lido && { titulo: lido.title, conteudo: lido.content, idioma: lido.lang };
  });
  if (!artigo?.conteudo?.trim()) falha("Não encontrei o conteúdo da página.");

  const titulo = (artigo.titulo || alvo.hostname).trim();
  const quando = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeZone: "America/Sao_Paulo" }).format(new Date());
  await mkdir(pasta, { recursive: true });

  const html = documento({ titulo, link: alvo.href, quando, conteudo: artigo.conteudo, idioma: artigo.idioma });
  await writeFile(`${pasta}/${versao}.html`, html);

  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  // Tabelas ficam em HTML dentro do .md: o Turndown sozinho não gera tabela Markdown.
  turndown.keep(["table"]);
  // Todo <pre> vira bloco de código com o texto exatamente como está. O Turndown só
  // reconhece <pre><code>; o GitHub e muitos sites usam <pre> sozinho, e aí o código
  // virava parágrafo com caracteres escapados.
  turndown.addRule("codigo", {
    filter: "pre",
    replacement: (_conteudo, no) => {
      const codigo = no.textContent.replace(/\n$/, "");
      const classes = [no, no.querySelector("code"), no.parentNode]
        .map((el) => el?.getAttribute?.("class") || "")
        .join(" ");
      const linguagem = /(?:language|lang|highlight-source)-([\w#+.-]+)/.exec(classes)?.[1] || "";
      const crases = Math.max(2, ...(codigo.match(/`+/g) || []).map((s) => s.length));
      const cerca = "`".repeat(crases + 1);
      return `\n\n${cerca}${linguagem}\n${codigo}\n${cerca}\n\n`;
    },
  });
  const md = `# ${titulo}\n\nFonte: <${alvo.href}>  \nExtraído em ${quando}\n\n---\n\n${turndown.turndown(artigo.conteudo)}\n`;
  await writeFile(`${pasta}/${versao}.md`, md);

  await page.setContent(html, { waitUntil: "load" });
  await page.pdf({
    path: `${pasta}/${versao}.pdf`,
    format: "A4",
    printBackground: true,
    margin: { top: "18mm", bottom: "18mm", left: "16mm", right: "16mm" },
  });

  console.log(`${pasta}/${versao}.{md,html,pdf}`);
} catch (erro) {
  // Qualquer erro inesperado também chega à página como motivo do alerta.
  falha(`A extração falhou: ${erro.message.split("\n")[0]}`);
} finally {
  await browser.close();
}

// Para quem roda à mão: data e hora (UTC) e um sufixo curto, o mesmo formato da página.
function novaVersao() {
  const d = new Date().toISOString().slice(0, 19).replace("T", "-").replace(/:/g, "");
  return `${d}-${Math.random().toString(36).slice(2, 6)}`;
}

function escapar(texto) {
  return texto.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function documento({ titulo, link, quando, conteudo, idioma }) {
  return `<!doctype html>
<html lang="${escapar(idioma || "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapar(titulo)}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;font:16px/1.6 system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;color:#1c1c1e;background:#fff}
@media (prefers-color-scheme:dark){body{color:#f5f5f7;background:#111}a{color:#64d2ff}}
main{max-width:46rem;margin:0 auto;padding:2.5rem 1.25rem 4rem}
header{margin-bottom:2rem;padding-bottom:1rem;border-bottom:1px solid #8884}
header h1{margin:0 0 .5rem;font-size:1.9rem;line-height:1.2}
header p{margin:0;font-size:.9rem;opacity:.7;overflow-wrap:anywhere}
img,video{max-width:100%;height:auto}
pre{overflow-x:auto;padding:.9rem 1rem;border-radius:.5rem;background:#8881;white-space:pre}
code{font-family:ui-monospace,"JetBrains Mono",monospace;font-size:.9em}
table{border-collapse:collapse;display:block;overflow-x:auto}
th,td{border:1px solid #8884;padding:.35rem .6rem;text-align:left}
blockquote{margin:1rem 0;padding:0 1rem;border-left:3px solid #8886}
@media print{body{background:#fff;color:#000}pre{white-space:pre-wrap}a{color:#000}}
</style>
</head>
<body>
<main>
<header>
<h1>${escapar(titulo)}</h1>
<p>Fonte: <a href="${escapar(link)}">${escapar(link)}</a> · Extraído em ${escapar(quando)}</p>
</header>
<article>
${conteudo}
</article>
</main>
</body>
</html>
`;
}
