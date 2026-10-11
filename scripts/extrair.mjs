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

// O HTML e o PDF têm o visual do app: o fundo de manchas, o card de vidro e a
// marca ❯_loggerview. O PDF é este mesmo HTML impresso, com o vidro trocado por
// um branco translúcido (desfoque não imprime bem).
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
  --page-edge:#8b82e6;
  --base:linear-gradient(180deg,#8b82e6 0%,#c4bbf6 12%,#f2ebfb 28%,#eef2ff 50%,#fbecf3 72%,#c4bbf6 88%,#8b82e6 100%);
  --campos:
    radial-gradient(44vmax 26vmax at 10% 36%, rgb(255 158 205 / .72), transparent 70%),
    radial-gradient(40vmax 28vmax at 90% 40%, rgb(127 207 255 / .70), transparent 70%),
    radial-gradient(48vmax 20vmax at 32% 58%, rgb(255 212 154 / .66), transparent 70%),
    radial-gradient(34vmax 24vmax at 76% 66%, rgb(142 240 210 / .62), transparent 70%),
    radial-gradient(36vmax 22vmax at 18% 72%, rgb(201 166 255 / .62), transparent 70%),
    radial-gradient(24vmax 30vmax at 58% 42%, rgb(255 184 168 / .50), transparent 70%),
    radial-gradient(30vmax 18vmax at 92% 80%, rgb(169 200 255 / .56), transparent 70%);
  --text:#1c1c1e; --forte:#0a0b0d; --sub:rgba(0,0,0,.6);
  --vidro:rgba(238,240,245,.3); --frost:blur(5px) saturate(1.15);
  --bloco:rgba(255,255,255,.55); --linha:rgba(0,0,0,.12);
  --sombra:0 10px 28px rgba(30,20,90,.16), 0 2px 6px rgba(30,20,90,.08);
  --mono:"JetBrains Mono",ui-monospace,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root{
  --page-edge:#1b1646;
  --base:linear-gradient(180deg,#1b1646 0%,#281f6a 12%,#1d2a60 28%,#16304d 50%,#2b1e58 72%,#281f6a 88%,#1b1646 100%);
  --campos:
    radial-gradient(44vmax 26vmax at 10% 36%, rgb(214 70 160 / .44), transparent 70%),
    radial-gradient(40vmax 28vmax at 90% 40%, rgb(40 160 220 / .42), transparent 70%),
    radial-gradient(48vmax 20vmax at 32% 58%, rgb(230 140 60 / .28), transparent 70%),
    radial-gradient(34vmax 24vmax at 76% 66%, rgb(40 200 170 / .32), transparent 70%),
    radial-gradient(36vmax 22vmax at 18% 72%, rgb(120 80 230 / .42), transparent 70%),
    radial-gradient(24vmax 30vmax at 58% 42%, rgb(200 80 140 / .28), transparent 70%),
    radial-gradient(30vmax 18vmax at 92% 80%, rgb(60 120 220 / .34), transparent 70%);
  --text:#f5f5f7; --forte:#fff; --sub:rgba(255,255,255,.6);
  --vidro:rgba(18,18,20,.3); --bloco:rgba(0,0,0,.32); --linha:rgba(255,255,255,.14);
  color-scheme:dark;
}}
*{box-sizing:border-box}
html::before,html::after{content:"";position:fixed;z-index:-1;left:0;right:0;top:0;height:100vh;height:100lvh;pointer-events:none}
html::before{background:var(--base)}
html::after{background:var(--campos);
  -webkit-mask-image:linear-gradient(180deg,transparent 0 14%,#000 30% 70%,transparent 86% 100%);
          mask-image:linear-gradient(180deg,transparent 0 14%,#000 30% 70%,transparent 86% 100%)}
body{margin:0;padding:clamp(16px,4vw,48px) max(16px,env(safe-area-inset-left));background-color:var(--page-edge);
  color:var(--text);font:16px/1.65 system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;overflow-wrap:break-word}
main{max-width:48rem;margin:0 auto;padding:clamp(22px,4vw,40px);border-radius:30px;background:var(--vidro);
  -webkit-backdrop-filter:var(--frost);backdrop-filter:var(--frost);box-shadow:var(--sombra)}
.marca{margin:0 0 1.2rem;font:700 15px/1 var(--mono);letter-spacing:-.03em;color:var(--forte)}
.marca .chev{font-family:"Noto Sans Symbols 2",sans-serif;font-weight:400;font-size:.837em;vertical-align:.075em}
header{margin-bottom:1.8rem;padding-bottom:1.2rem;border-bottom:1px solid var(--linha)}
header h1{margin:0 0 .5rem;font-size:clamp(1.6rem,4vw,2.1rem);line-height:1.2;letter-spacing:-.02em;color:var(--forte)}
header p{margin:0;font-size:.9rem;color:var(--sub);overflow-wrap:anywhere}
h1,h2,h3,h4,h5,h6{color:var(--forte);line-height:1.25;letter-spacing:-.01em;margin:1.8em 0 .6em}
a{color:inherit;text-underline-offset:2px}
img,video{max-width:100%;height:auto;border-radius:12px}
code{font-family:var(--mono);font-size:.88em;padding:.1em .35em;border-radius:6px;background:var(--bloco)}
pre{overflow-x:auto;padding:1rem 1.1rem;border-radius:16px;background:var(--bloco);white-space:pre;line-height:1.5}
pre,pre code{font-family:var(--mono);font-size:.85rem}
pre code{padding:0;background:none}
blockquote{margin:1.2rem 0;padding:.2rem 1.1rem;border-left:3px solid var(--sub);color:var(--sub)}
table{border-collapse:collapse;display:block;overflow-x:auto;margin:1rem 0}
th,td{border:1px solid var(--linha);padding:.4rem .7rem;text-align:left}
hr{border:0;border-top:1px solid var(--linha);margin:2rem 0}
@page{size:A4;margin:0}
/* Impressão (o PDF): só recursos que qualquer visualizador desenha. Sem as manchas
   com máscara e sem transparência (viram máscaras e grupos que vários leitores
   de PDF mostram em branco), cores sólidas, e fontes DejaVu (as da máquina do
   GitHub) no lugar da JetBrains Mono e da fonte do sistema, que o Chromium pode
   embutir como fonte Type 3. */
@media print{
  html::after{display:none}
  body{padding:14mm 12mm;font-family:"DejaVu Sans","Liberation Sans",sans-serif}
  main{max-width:none;background:#fbfaff;-webkit-backdrop-filter:none;backdrop-filter:none;box-shadow:none;
    -webkit-box-decoration-break:clone;box-decoration-break:clone}
  :root{--bloco:#efedf7;--linha:#dedbe9;--sub:#55536a}
  pre,pre code,code,.marca{font-family:"DejaVu Sans Mono","Liberation Mono",monospace}
  pre{white-space:pre-wrap;break-inside:avoid}
  h1,h2,h3,h4{break-after:avoid}
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
