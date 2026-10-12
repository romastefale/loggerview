# ❯_loggerview

Uma página simples para guardar changelogs de APIs.

Você cola o link de um changelog, ou de qualquer página de documentação, confirma o pedido no GitHub e recebe o conteúdo completo da publicação em três formatos:

- **.md**: texto limpo, bom para ler e para usar com agentes de IA;
- **HTML**: abre em qualquer navegador;
- **PDF**: pronto para guardar ou imprimir.

Cada pedido fica guardado na pasta `biblioteca/`, organizado por site e com a data da extração. Como não há como saber se o site mudou, cada pedido gera uma versão nova, sem apagar as anteriores.

## Como usar

1. Abra **https://romastefale.github.io/loggerview/**
2. Cole o link, pelo botão de colar ou direto no campo, e toque na lupa.
3. Confirme o pedido na página do GitHub que abrir.
4. Volte para a página e baixe o formato que quiser.

Tudo funciona dentro do próprio GitHub, de graça, sem servidor e sem senha. Só o dono do repositório pode fazer pedidos.
