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
  // Links sem texto (o ícone de âncora ao lado dos títulos) não levam a nada no .md.
  turndown.addRule("link-vazio", {
    filter: (no) => no.nodeName === "A" && !no.textContent.trim() && !no.querySelector("img"),
    replacement: () => "",
  });
  // Itens de lista com "- " e o recuo do tamanho do marcador (o padrão do Turndown é "-   ").
  turndown.addRule("item", {
    filter: "li",
    replacement: (conteudo, no, opcoes) => {
      const lista = no.parentNode;
      let marcador = `${opcoes.bulletListMarker} `;
      if (lista.nodeName === "OL") {
        const inicio = Number(lista.getAttribute("start") || 1);
        marcador = `${inicio + Array.prototype.indexOf.call(lista.children, no)}. `;
      }
      const texto = conteudo
        .replace(/^\n+/, "")
        .replace(/\n+$/, "\n")
        .replace(/\n(?!\n|$)/g, `\n${" ".repeat(marcador.length)}`);
      return marcador + texto + (no.nextSibling && !/\n$/.test(texto) ? "\n" : "");
    },
  });
  const corpo = turndown.turndown(artigo.conteudo).replace(/\n{3,}/g, "\n\n");
  const md = `# ${titulo}\n\n> Fonte: <${alvo.href}>  \n> Extraído em ${quando}\n\n---\n\n${corpo}\n`;
  await writeFile(`${pasta}/${versao}.md`, md);

  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: `${pasta}/${versao}.pdf`, format: "A4", printBackground: true, preferCSSPageSize: true });

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

// O HTML e o PDF são uma folha de leitura: fundo neutro (branco; quase preto no
// modo escuro do HTML), sem degradê nem vidro, porque o foco é o conteúdo. Nada
// pode cortar na impressão: tabelas ocupam a largura da folha e quebram o texto
// nas células, código e palavras longas quebram a linha. O PDF usa fontes DejaVu
// (as da máquina do GitHub), que qualquer leitor de PDF desenha.
function documento({ titulo, link, quando, conteudo, idioma }) {
  return `<!doctype html>
<html lang="${escapar(idioma || "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapar(titulo)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+Symbols+2&text=%E2%9D%AF&display=swap">
<style>
:root{
  --fundo:#fff; --text:#1c1c1e; --forte:#0a0b0d; --sub:#5b6270;
  --bloco:#f3f5f8; --linha:#dde2ea; --cabeca:#eef1f5;
  --mono:"JetBrains Mono",ui-monospace,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root{
  --fundo:#121417; --text:#e9ebef; --forte:#fff; --sub:#a3aab6;
  --bloco:#1c2026; --linha:#2e343d; --cabeca:#1a1e24;
  color-scheme:dark;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--fundo);color:var(--text);
  font:16px/1.65 system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;overflow-wrap:break-word}
main{max-width:48rem;margin:0 auto;padding:clamp(20px,5vw,48px) max(16px,env(safe-area-inset-left))}
.marca{margin:0 0 1.2rem;font:700 14px/1 var(--mono);letter-spacing:-.03em;color:var(--sub)}
.marca .chev{font-family:"Noto Sans Symbols 2",sans-serif;font-weight:400;font-size:.837em;vertical-align:.075em}
header{margin-bottom:1.8rem;padding-bottom:1.2rem;border-bottom:1px solid var(--linha)}
header h1{margin:0 0 .5rem;font-size:clamp(1.6rem,4vw,2.1rem);line-height:1.2;letter-spacing:-.02em;color:var(--forte)}
header p{margin:0;font-size:.9rem;color:var(--sub);overflow-wrap:anywhere}
h1,h2,h3,h4,h5,h6{color:var(--forte);line-height:1.25;letter-spacing:-.01em;margin:1.8em 0 .6em}
a{color:inherit;text-underline-offset:2px}
img,video{max-width:100%;height:auto}
code{font-family:var(--mono);font-size:.88em;padding:.1em .35em;border-radius:5px;background:var(--bloco);overflow-wrap:anywhere}
pre{overflow-x:auto;padding:.9rem 1rem;border-radius:10px;background:var(--bloco);border:1px solid var(--linha);white-space:pre;line-height:1.5}
pre,pre code{font-family:var(--mono);font-size:.85rem}
pre code{padding:0;background:none;overflow-wrap:normal}
blockquote{margin:1.2rem 0;padding:.1rem 1rem;border-left:3px solid var(--linha);color:var(--sub)}
table{width:100%;border-collapse:collapse;margin:1rem 0;font-size:.92em}
th,td{border:1px solid var(--linha);padding:.45rem .6rem;text-align:left;vertical-align:top;overflow-wrap:break-word}
th{background:var(--cabeca);font-weight:600;color:var(--forte)}
/* Tela estreita: uma tabela de várias colunas não cabe. Cada linha vira um bloco,
   com as células uma embaixo da outra (a primeira em destaque), na largura da tela,
   sem rolagem nem corte. Na folha (PDF) e em telas largas continua tabela, e só
   quebra a palavra que sozinha não cabe. */
@media screen and (max-width:640px){
  table,tbody,tr,td,th{display:block;width:auto}
  thead{display:none}
  table{border:0}
  tr{border:1px solid var(--linha);border-radius:10px;padding:.55rem .75rem;margin:0 0 .6rem}
  th,td{border:0;padding:.1rem 0;overflow-wrap:anywhere}
  tr>:first-child{font-weight:600;color:var(--forte)}
  tr>:nth-child(2):not(:last-child){font-size:.88em;color:var(--sub)}
}
hr{border:0;border-top:1px solid var(--linha);margin:2rem 0}
@page{size:A4;margin:16mm 14mm}
@media print{
  :root{--fundo:#fff;--text:#1c1c1e;--forte:#000;--sub:#555b66;--bloco:#f3f5f8;--linha:#d5dae2;--cabeca:#eef1f5;color-scheme:light}
  body{font-family:"DejaVu Sans","Liberation Sans",sans-serif;font-size:10.5pt;line-height:1.55}
  main{max-width:none;padding:0}
  pre,pre code,code,.marca{font-family:"DejaVu Sans Mono","Liberation Mono",monospace}
  pre{white-space:pre-wrap;overflow:visible;font-size:8.5pt}
  pre code{overflow-wrap:anywhere}
  table{font-size:9pt}
  thead{display:table-header-group}
  tr,img{break-inside:avoid}
  h1,h2,h3,h4{break-after:avoid}
  a{color:inherit}
}
</style>
</head>
<body>
<main>
<p class="marca"><span class="chev">❯</span>_loggerview</p>
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
