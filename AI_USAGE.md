# Uso de IA neste projeto

A maior parte do código, dos testes e dos rascunhos de documentação foi escrita pelo Claude Code, a partir de um plano feito com a IA e de um contrato (endpoints, erros, schema SQL, idempotência) fixado antes do código; plano e contrato não estão no repositório. Revisei e entendi cada trecho entregue. A responsabilidade é minha, e as decisões abaixo são o que vou defender na revisão ao vivo. O verificável está em `make test`, no CI e no histórico.

## Ferramentas utilizadas

- **Claude Code** (CLI da Anthropic), modelos Claude Opus e Sonnet: enunciado, plano, código, testes, revisão e rascunho da documentação.

## Como o trabalho rodou

Contrato antes do código; tarefas pequenas, cada uma revisada por outra instância de IA, independente de quem escreveu, contra os modos de falha do enunciado. Teste verde só vale como prova depois de mutar o código e ver o teste falhar. Rodar de verdade (suíte, compose, roteiro do README). No fim, duas rodadas de revisão do código inteiro, a primeira pedida por mim já na primeira instrução, cada uma seguida de correções.

## Onde a IA ajudou

- Caça de pegadinhas no enunciado (pedido meu na primeira instrução): `0.1 + 0.2`, UUID inválido, retry com a original rodando, A→B e B→A, borda do período, documento duplicado em paralelo.
- Plano em tarefas pequenas e geração inicial de código e testes.
- Revisão de concorrência: ordem dos locks e se cada teste exercita o caminho que diz exercitar.
- Revisão independente por tarefa e do código inteiro (idempotência, falhas do banco, segurança, clone limpo).
- Rascunho do README, deste arquivo e dos GIFs de `docs/gifs/` (script Pillow fora do repositório).

## Exemplo de interação relevante: idempotência

**Problema.** Um retry com a mesma `Idempotency-Key` não pode debitar duas vezes; e se a chave volta com outro payload?

**O que a IA propôs.** No plano, um hash do corpo cru, o padrão dos exemplos. Mas `250` e `250.00` são o mesmo valor e os campos podem vir em outra ordem: um retry legítimo viraria "payload diferente".

**Decisão final.** Comparar campos normalizados (origem, destino, centavos; no depósito, conta e centavos). `250` e `250.00` em qualquer ordem são replay; mesma chave com outra conta ou valor é 422 `IDEMPOTENCY_KEY_REUSED`, em vez de a API escolher uma das intenções. Custo: mudar o pedido exige outra chave. Prova: `test/api/idempotency.test.ts`. Regras completas: README, seção 4.

## Validação crítica

1. **Testes de concorrência que não provavam nada.** Depósitos paralelos, 10 transferências com a mesma chave e dois relays ficavam verdes com o código mutado (re-read trocado por `throw`, sem `ON CONFLICT`, sem `SKIP LOCKED`): as requisições quase não se sobrepunham. Achou: a mutação, feita pela IA que escreveu cada teste. Decisão: mutação como critério; os testes seguram o lock até as requisições enfileirarem (`waitForQueue` em `test/helpers.ts`; no relay, um portão). Agentes de IA refizeram as mutações numa cópia, e li os resultados. Prova: tire a cláusula e rode `test/api/idempotency.test.ts`, `test/api/deposits.test.ts` ou `test/outbox.test.ts`.
2. **A correção que vazou uma transação.** Depois da revisão do código inteiro, um `query_timeout` entrou para nada esperar um banco congelado. Um teste da IA que implementava pegou o efeito colateral (`expected 1 to be 0`): o `ROLLBACK` também estourava, a conexão voltava ao pool com a transação aberta e o `COMMIT` seguinte gravou o INSERT de uma requisição que recebeu 503. Decisão: `ROLLBACK` com 1 s de limite; se falhar, a conexão é destruída. Prova: `test/db.test.ts` ("never leaks").
3. **Uma ordenação que o `EXPLAIN` desmentiu.** A especificação de correção, escrita com a IA, mandava `ORDER BY account_id, id` para o extrato de conta enorme não varrer a PK. A IA que implementava mediu com `EXPLAIN ANALYZE`: o planner descarta `account_id` (igualado a constante) e o plano é idêntico; `(account_id, id) > (...)` só consertava a primeira página. Decisão: nada entrou; a limitação está no README, seção 6.
4. **O plano errou o contrato.** Um revisor (IA) viu que `1e15` dava 400 e `2e9` dava 422; agora o teto vem primeiro e tudo acima de R$ 1 bilhão é 422 (`test/unit/money.test.ts`). O plano assumia 415 para `text/plain`; o teste deu 400 (parser padrão do Fastify), o parser saiu (`src/app.ts`) e o teste ficou (`test/api/accounts.test.ts`).

Outros achados, todos com teste de regressão: NUL no nome e no `last_error` do relay, UUID em maiúsculas no replay do depósito, `READ COMMITTED` fixado no `BEGIN`, pool sem timeout, `detail` do `pg` no log, extrato ordenado como texto; os healthchecks do compose estão no smoke do CI. E um de processo: a IA recomendou a stack antes de ler a vaga; pedi para validar contra a vaga (Node.js e TypeScript obrigatórios) e ela se manteve.

O que se repetiu: mutar antes de confiar num teste verde, revisão independente de quem escreveu, e rodar de verdade.
