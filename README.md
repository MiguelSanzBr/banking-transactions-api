# Banking Transactions API

API REST de contas e movimentações financeiras: criar conta, bloquear/desbloquear/encerrar, depositar, transferir entre contas com idempotência, consultar transferência e extrato paginado. Foco: **saldo nunca negativo, nenhuma movimentação duplicada e tudo rastreável**, com o código mais simples que defenda isso.

Stack: Node 24 + TypeScript, Fastify 5, Zod 4, `pg` (SQL puro, sem ORM), PostgreSQL 17, Vitest + Testcontainers, Biome. Como a IA foi usada: [AI_USAGE.md](AI_USAGE.md). Enunciado do desafio: [docs/desafio_tecnico_banking_transactions_services.md](docs/desafio_tecnico_banking_transactions_services.md).

## 1. Como rodar

Pré-requisito: Docker (Compose v2). Node 24 (o `.nvmrc` fixa a versão: `nvm use`) só é necessário para rodar testes e lint fora do container.

```bash
docker compose up --build   # ou: make up
```

Sobe a API e o PostgreSQL; as migrations rodam na inicialização, sem configuração manual. O comando fica em primeiro plano, com os logs no terminal (Ctrl+C para parar); com `-d` ele devolve o terminal e `docker compose logs -f api` acompanha. A API fica em http://localhost:3000, publicada só em 127.0.0.1 (não tem autenticação); Swagger UI em `/docs` (OpenAPI JSON em `/docs/json`); liveness em `/health` e readiness em `/ready`.

- Porta 3000 ocupada: `API_PORT=3400 docker compose up --build`. `POSTGRES_USER`, `POSTGRES_PASSWORD` e `POSTGRES_DB` também são variáveis do compose (veja `.env.example`).
- `make down` mantém o volume do banco. Para zerar os dados use `docker compose down -v`; isso também é necessário depois de mudar `POSTGRES_PASSWORD`, porque o Postgres só lê a senha na primeira inicialização.
- CI (`.github/workflows/ci.yml`): lint, build, testes, `docker build` e um smoke do compose em `/ready`.

Variáveis da API, todas com padrão exceto `DATABASE_URL` (obrigatória; o compose a define e repassa as demais, menos `PORT`): `PORT` (3000), `LOG_LEVEL` (info), `DB_POOL_MAX` (10), `DB_LOCK_TIMEOUT_MS` (5000), `DB_STATEMENT_TIMEOUT_MS` (15000), `DB_IDLE_IN_TX_TIMEOUT_MS` (30000), `OUTBOX_RELAY_ENABLED` (true; liga o relay do outbox nesta instância) e `OUTBOX_RELAY_INTERVAL_MS` (1000).

## 2. Testes

```bash
make test   # na primeira vez instala as dependências (npm ci); depois vitest, e o Testcontainers sobe um Postgres 17 descartável sozinho (precisa de Docker)
make lint   # Biome + tsc --noEmit (também instala as dependências se faltarem)
npm ci && npm test   # o mesmo sem make, com Node 24 (lint: npm run lint)
```

Os testes de API chamam a aplicação real (`app.inject`) contra um Postgres de verdade, sem mocks: um banco em memória não reproduziria locks, `CHECK`, `ON CONFLICT` nem timeouts, que são o que está em teste. Os testes de corrida da idempotência (transferência e depósito) seguram o lock até as requisições enfileirarem, esperando por `pg_blocking_pids`; o do relay usa um portão. Sem isso, quase não há sobreposição.

Mutar o código confirma: sem o `ON CONFLICT` (em transferência e em depósito) ou sem o `SKIP LOCKED`, o teste correspondente falha. Essas mutações foram rodadas durante o desenvolvimento por agentes de IA, numa cópia do código, e li os resultados; qualquer um refaz tirando a cláusula e rodando o arquivo de teste ([AI_USAGE.md](AI_USAGE.md), Validação crítica, item 1).

| Arquivo | O que prova |
|---|---|
| `test/unit/*.test.ts` | dinheiro: `0.1 + 0.2` e `1e-7` → 400; zero e negativo → 422 `INVALID_AMOUNT`; `1e15` e tudo acima do teto → 422 `AMOUNT_LIMIT_EXCEEDED`; o teto exato passa. Contas: transições de status (CLOSED terminal, mesmo status é no-op, não encerra com saldo); CPF/CNPJ só dígitos ou máscara canônica. Transferência: origem não ativa, destino encerrado, saldo insuficiente, destino BLOCKED recebe. Config: padrões, env e falha rápida sem `DATABASE_URL` |
| `test/api/foundation.test.ts` | `/health` e `/ready` sem log de requisição; envelope de erro (400/404/413/415/500/503) sem mensagem interna nem `detail` do `pg` no log; 4xx e 5xx logados com `code` e `idempotencyKey` só se válida (senão `idempotencyKeyInvalid: true`), nunca o corpo; URL mal codificada e parâmetro longo no envelope; códigos de conexão (`57P03`, `ENOTFOUND`, classe 08, `Connection terminated`...), cliente morto, `query_timeout` e pool esgotado → 503; `correlationId` aceito, gerado e no log; migrations idempotentes; timeouts de sessão em toda conexão; `BIGINT` como `number`; commit e rollback do `withTransaction` |
| `test/db.test.ts` | `READ COMMITTED` mesmo com padrão `REPEATABLE READ`; backend morto no meio da transação → 503, processo e pool vivos, retry funciona; erro de client ocioso não derruba o processo; `idle_in_transaction_session_timeout` vem das opções; banco que não responde: desiste em `query_timeout` + 1 s e a conexão não volta ao pool com a transação aberta (o INSERT não é gravado) |
| `test/server.test.ts` | processo real (`src/server.ts`): banco fora → log estruturado e saída 1; `SIGTERM` com requisição em andamento numa conexão keep-alive → 201 e saída 0 bem antes do prazo de 20 s |
| `test/api/accounts.test.ts` | criar, consultar, mudar status (mesmo status: 200 sem efeito); documento duplicado com e sem máscara; espaços nas pontas aceitos; 5 criações paralelas do mesmo documento → 1 × 201 e 4 × 409; nome com controle, bidi, U+FFFD ou sem letra, máscara inválida, UUID inválido, campo extra, JSON malformado, UTF-8 inválido → 400; `text/plain` → 415; logs `account created` e `account status changed` sem documento nem nome |
| `test/api/deposits.test.ts` | 10 × R$ 0,10 = R$ 1,00 exato; BLOCKED recebe, CLOSED → 422; idempotência, inclusive com o id da conta em maiúsculas; log `deposit processed`; 5 paralelas com a mesma chave |
| `test/api/transfers.test.ts` | R$ 150 com saldo de R$ 100 → 422, saldo intacto, tentativa `FAILED`; origem BLOCKED/CLOSED, destino CLOSED, mesma conta, conta inexistente (404); valor inválido não grava nem consome a chave; evento do outbox (com `correlationId`) só nas concluídas |
| `test/api/idempotency.test.ts` | retry: um débito, mesma resposta, `Idempotent-Replayed: true`; `250` = `250.00` em outra ordem; outro valor, destino ou origem → 422; replay de `FAILED` segue `FAILED` depois de depositar; replay depois de bloquear a origem → 201 original; 10 paralelas com a mesma chave → uma movimentação, mesmo `id` |
| `test/api/concurrency.test.ts` | R$ 100 e duas de R$ 80 em paralelo → só uma conclui; rajadas paralelas sem saldo negativo; A→B e B→A simultâneos sem deadlock; rajada aleatória entre 5 contas com saldo = soma do ledger; conta quente travada → 503 + `Retry-After`, e o retry com a mesma chave executa depois |
| `test/api/statement.test.ts` | ordem e `balanceAfter`; mesmo `createdAt` na resposta e no extrato (também em SQL, depois de esperar um lock); `FAILED` fora; borda (`to=2026-09-10` inclui `23:59:59.999Z` e exclui `2026-09-11T00:00:00Z`); data, `limit` (só dígitos, 1–100, padrão 50) e `cursor` inválidos → 400; paginação sem duplicar; ordem numérica do `id` na virada de dígitos; BLOCKED e CLOSED têm extrato |
| `test/api/openapi.test.ts`, `validation.test.ts` | `/docs/json` é OpenAPI 3 com todas as rotas; todo erro é `$ref` ao único `ErrorEnvelope`; `amount` com descrição e exemplo, `holderName` sem `pattern`; `/docs` serve o Swagger UI; mensagem única da `Idempotency-Key` inválida ou ausente |
| `test/outbox.test.ts` | banco próprio; publica uma vez; falha incrementa `attempts` e para em `maxAttempts` (3 no teste, 10 por padrão); falha → `warn`, evento parado → `error`; falha retentada só no próximo intervalo; `last_error` truncado e sem NUL; dois relays não publicam o mesmo evento (`SKIP LOCKED`); publicador mais lento que o `idle_in_transaction` derruba a rodada, não o processo; `startRelay` para limpo e drena backlog de vários lotes sem esperar um intervalo por lote |

![Como saber que funciona: testes contra PostgreSQL real, mutação que remove o ON CONFLICT e faz o teste falhar, e a coleção do Bruno](docs/gifs/7-como-sei-que-funciona.gif)

## 3. Consumindo a API

Swagger UI em `/docs`, gerado dos mesmos schemas Zod que validam as requisições (não diverge do código). Dinheiro trafega como `number` em reais (`"amount": 250.00`) e datas em ISO 8601 UTC. Rotas: `POST /accounts`, `GET /accounts/{id}`, `PATCH /accounts/{id}/status`, `POST /accounts/{id}/deposits`, `POST /transfers`, `GET /transfers/{id}`, `GET /accounts/{id}/statement?from&to&limit&cursor`, `GET /health`, `GET /ready`. A pasta `bruno/` é uma coleção do [Bruno](https://www.usebruno.com) com todas elas (abra a pasta, escolha o ambiente `local` e rode a coleção em ordem: os requests passam ids de um para o outro por variáveis).

Roteiro com `curl` (bash ou zsh, não `sh`; precisa de `jq`; a API tem que estar no ar):

```bash
BASE=http://localhost:3000   # outra porta se subiu com API_PORT (seção 1)
JSON='content-type: application/json'
# 1. duas contas; RUN deixa documentos e chaves únicos (a chave é global), então o roteiro pode rodar mais de uma vez
RUN=$RANDOM$RANDOM
DOC_A=$(printf '%011d' "${RUN}1"); DOC_B=$(printf '%011d' "${RUN}2")
A=$(curl -s -X POST $BASE/accounts -H "$JSON" -d "{\"holderName\":\"Ana Souza\",\"document\":\"$DOC_A\"}" | jq -r .id)
B=$(curl -s -X POST $BASE/accounts -H "$JSON" -d "{\"holderName\":\"Bruno Lima\",\"document\":\"$DOC_B\"}" | jq -r .id)
# 2. mesmo documento de novo -> 409 DOCUMENT_ALREADY_EXISTS
curl -s -X POST $BASE/accounts -H "$JSON" -d "{\"holderName\":\"Outra Ana\",\"document\":\"$DOC_A\"}"
# 3. depósito de R$ 500 em A -> 201; com chave, um retry depois de um 503 não credita duas vezes
curl -s -X POST $BASE/accounts/$A/deposits -H "$JSON" -H "Idempotency-Key: dep-$RUN" -d '{"amount":500.00}'
# 4. transferência A -> B de R$ 250 com a chave abc123-$RUN -> 201 COMPLETED (guarde o id)
BODY="{\"sourceAccountId\":\"$A\",\"destinationAccountId\":\"$B\",\"amount\":250.00}"
T=$(curl -s -X POST $BASE/transfers -H "$JSON" -H "Idempotency-Key: abc123-$RUN" -d "$BODY" | jq -r .id)
# 5. retry: mesma chave, mesmo payload (250 == 250.00) -> 201 igual + "Idempotent-Replayed: true"; saldo de A continua 250
curl -si -X POST $BASE/transfers -H "$JSON" -H "Idempotency-Key: abc123-$RUN" -d "${BODY/250.00/250}"
curl -s $BASE/accounts/$A
# 6. mesma chave, valor diferente -> 422 IDEMPOTENCY_KEY_REUSED
curl -s -X POST $BASE/transfers -H "$JSON" -H "Idempotency-Key: abc123-$RUN" -d "${BODY/250.00/100.00}"
# 7. saldo insuficiente -> 422 INSUFFICIENT_BALANCE com transferId; a tentativa fica registrada como FAILED
curl -s -X POST $BASE/transfers -H "$JSON" -H "Idempotency-Key: def456-$RUN" -d "${BODY/250.00/1000.00}"
# 8. consultar a transferência do passo 4
curl -s $BASE/transfers/$T
# 9. extrato de hoje (UTC), 1 item por página: a segunda chamada usa o nextCursor da primeira
TODAY=$(date -u +%F)
PAGE=$(curl -s "$BASE/accounts/$A/statement?from=$TODAY&to=$TODAY&limit=1"); echo "$PAGE"
curl -s "$BASE/accounts/$A/statement?from=$TODAY&to=$TODAY&limit=1&cursor=$(echo "$PAGE" | jq -r .nextCursor)"
# 10. bloquear A: não debita (422 SOURCE_ACCOUNT_NOT_ACTIVE), mas ainda recebe crédito (201)
curl -s -X PATCH $BASE/accounts/$A/status -H "$JSON" -d '{"status":"BLOCKED"}'
curl -s -X POST $BASE/transfers -H "$JSON" -H "Idempotency-Key: ghi789-$RUN" -d "${BODY/250.00/10.00}"
curl -s -X POST $BASE/accounts/$A/deposits -H "$JSON" -d '{"amount":10.00}'
# 11. entradas inválidas nunca viram 500
curl -s -X POST $BASE/transfers -H "$JSON" -H "Idempotency-Key: jkl012-$RUN" -d "${BODY/250.00/0.30000000000000004}"   # 400 (mais de 2 casas)
curl -s -X POST $BASE/accounts/$A/deposits -H "$JSON" -d '{"amount":-5}'                                               # 422 INVALID_AMOUNT
curl -s $BASE/accounts/nao-e-uuid                                                                                      # 400
curl -s -X POST $BASE/transfers -H "$JSON" -d "$BODY"                                                                  # 400 (sem Idempotency-Key)
# 12. rastrear: pelo correlation id (as linhas dessa requisição) e pelo transferId (`transfer processed`, o original e o replay; as linhas da consulta do passo 8; e, em até 1 s, `event published`)
curl -s -H 'x-correlation-id: demo-123' $BASE/accounts/$A
docker compose logs api | grep demo-123
sleep 1   # o event published sai até ~1 s depois da transferência
docker compose logs api | grep "$T"
```

## 4. Decisões

Decisão → custo, em uma linha cada:

- Lock pessimista (`FOR UPDATE`) em ordem fixa de `id` → sem deadlock, mas as transferências de uma mesma conta entram em fila (conta quente, seção 6).
- `READ COMMITTED` fixado no `BEGIN` → o re-read depois do `ON CONFLICT` enxerga a linha da outra requisição; quem serializa são os locks de linha.
- Rejeição de negócio gravada como `FAILED`, consumindo a chave → replay determinístico; quem depositou depois e reenviou com a mesma chave segue vendo a 422.
- Centavos em `BIGINT` e `number` inteiro no TS → nenhuma conta com float; teto de 2^53 centavos (seção 8).
- Cursor do extrato pelo `id` do ledger → sem repetir nem pular linhas; a ordem é a das mudanças de saldo, não uma ordenação por data.
- Evento no outbox na mesma transação → nenhum evento perdido nem fantasma; entrega at least once, o consumidor deduplica.

### Estrutura: por feature, sem Clean/Hexagonal

`src/accounts/`, `transfers/`, `deposits/` e `statement/` têm `routes.ts` (HTTP e schemas Zod de entrada, saída e OpenAPI) e `service.ts` (SQL e transação); só `accounts` e `transfers` têm `rules.ts` (regra de negócio sem I/O, testável sem banco). `outbox/relay.ts` é o relay, sem rotas. Na raiz: `server.ts` (boot, relay, shutdown), `app.ts` (Fastify: correlation id, erros, OpenAPI, módulos), `db.ts` (pool, `withTransaction`, migrations), `config.ts`, `health.ts`; `shared/` tem `errors.ts`, `money.ts`, `schemas.ts`. O schema está em `migrations/001_init.sql`, editada no lugar porque nada foi implantado; depois de um deploy, mudança entra como `002_*.sql` (o migrator só confere o nome).

Por que não Clean/Hexagonal: são 5 tabelas, e a correção da transferência *depende* do SQL (lock, ordem, `CHECK`, `ON CONFLICT`); portas e repositórios só repassariam chamadas e esconderiam esse trecho. Custo: trocar de banco reescreve os `service.ts`, o que não seria mecânico de qualquer jeito. Runtime: `fastify`; `zod` + `fastify-type-provider-zod` (um schema valida, tipa e gera o OpenAPI) com `@fastify/swagger` e `@fastify/swagger-ui`; `pg`. Sem ORM, pelo mesmo motivo.

![Arquitetura: cliente, Fastify, routes, service, rules, PostgreSQL e o relay do outbox](docs/gifs/1-arquitetura.gif)

### Transações e concorrência

- **Uma transação por comando.** Toda escrita roda em `withTransaction` (ROLLBACK em qualquer erro); `GET` roda sem transação. `READ COMMITTED` fixado no `BEGIN`: o re-read do `ON CONFLICT` precisa de um snapshot novo por comando; num banco com padrão `REPEATABLE READ`, toda corrida virava 503 (sem saldo errado, mas a API parava sob concorrência).
- **Lock pessimista, ordem fixa.** `SELECT ... ORDER BY id FOR UPDATE`: A→B e B→A pedem os locks na mesma ordem, sem deadlock. Duas transferências de R$ 80 com R$ 100 na conta executam em fila, e a segunda vê R$ 20 e é rejeitada. Com `lock_timeout` de 5 s, conta travada vira 503 + `Retry-After` em vez de pendurar ([outros limites](docs/operacao.md#timeouts-e-503)).
- **`CHECK (balance_cents >= 0)`** é a última defesa: se um bug debitar a mais, o Postgres aborta a transação.
- **Saldo materializado mais ledger.** `accounts.balance_cents` é travado e checado em O(1) a cada movimentação; `ledger_entries` guarda cada mudança com `balance_after_cents`, para extrato e auditoria. Os dois mudam na mesma transação; a invariante saldo = soma do ledger é coberta em `test/api/concurrency.test.ts`.

Por que não **otimista** (`version`): em conta quente o conflito é o caso comum, e cada colisão viraria erro + retry na aplicação. Por que não **SERIALIZABLE**: aborta com `40001` sob conflito (com falsos positivos dos predicate locks) e a transação inteira precisa ser reexecutada, pelo que `FOR UPDATE` já protege. Custo do que escolhi: transferências da mesma conta são serializadas (seção 6).

Por que não a **operação atômica** do enunciado (`UPDATE accounts SET balance_cents = balance_cents - $x WHERE id = $1 AND balance_cents >= $x AND status = 'ACTIVE'`):

- dois `UPDATE`s A→B e B→A dão deadlock a menos que travem em ordem de `id`, que é o que o `FOR UPDATE` já faz;
- ele diz *que* não debitou, não *por quê* (`INSUFFICIENT_BALANCE`, `SOURCE_ACCOUNT_NOT_ACTIVE`, conta inexistente), e a rejeição é gravada como `FAILED` com o motivo;
- status das duas contas e saldo precisam vir de uma leitura consistente, para valerem o `balance_after_cents` e a ordem do `id` do ledger.

Ele bastaria para um débito numa conta só; o ganho dele (menos idas ao banco com o lock preso) é a otimização que eu faria na conta quente (seção 6).

![Concorrência: duas transferências de 80,00 sobre 100,00, só uma completa; A→B e B→A sem deadlock](docs/gifs/4-concorrencia.gif)

### Idempotência

**Fluxo de `POST /transfers`** (uma transação, na ordem do código):

1. Busca a chave. Payload equivalente: replay; diferente: 422 `IDEMPOTENCY_KEY_REUSED`.
2. Trava as duas contas (`ORDER BY id FOR UPDATE`); falta alguma: 404.
3. Aplica as regras e insere em `transfers` com `ON CONFLICT (idempotency_key) DO NOTHING`, já `COMPLETED` ou `FAILED`.
4. Insert sem linha: outra requisição com a mesma chave commitou antes; relê a chave e responde como no passo 1, nunca 500.
5. Só se `COMPLETED`: atualiza os dois saldos e grava os dois lançamentos e o evento do outbox.

![Transferência passo a passo, com o estado do banco ao lado](docs/gifs/2-transferencia.gif)

Duas requisições simultâneas com a mesma chave caem no passo 4, nunca em 500 nem em duas movimentações. **Mesmas contas:** a segunda espera o lock e devolve o resultado da primeira (teste: 10 em paralelo, uma movimentação). **Contas diferentes:** 422 `IDEMPOTENCY_KEY_REUSED`; sem conta em comum, o `INSERT` da segunda espera a primeira no índice `UNIQUE`; com uma em comum (A→B e A→C), espera o lock dela e cai no passo 4. Esse caso decorre do `UNIQUE` e não tem teste dedicado.

- **Chave:** `Idempotency-Key`, 1–255 ASCII visíveis, não precisa ser UUID (o enunciado usa `abc123`). Obrigatória em `POST /transfers`. No depósito é opcional: sem chave, cada POST é um depósito novo; com chave, mesmos passos, sem `FAILED`. **Recomendo sempre enviá-la**: sem ela, um retry depois de um 503 pode creditar duas vezes ([503 incerto](docs/operacao.md#503-e-resultado-incerto)). `UNIQUE` em `transfers` e `deposits`, escopo global; em produção seria por cliente autenticado.
- **Equivalência por campos normalizados**, não pelo corpo cru: origem, destino e centavos (no depósito, conta e centavos). `250` e `250.00`, ou campos em outra ordem, são o mesmo payload.
- **Replay** devolve o mesmo status e `Idempotent-Replayed: true`: no 201, o mesmo corpo; na 422 de uma `FAILED`, o mesmo `code` e `transferId` (`timestamp` e `correlationId` são os da nova requisição). Nunca reexecuta, mesmo que o mundo tenha mudado.
- **Mesma chave, payload diferente → 422 `IDEMPOTENCY_KEY_REUSED`**, como no draft IETF `httpapi-idempotency-key-header`: rejeitar é mais seguro que escolher uma das intenções, e o cliente com bug de reuso descobre na hora.
- **Rejeição de negócio depois de travar as contas** (saldo insuficiente, origem não ativa, destino encerrado) é **gravada** como `FAILED` e **consome a chave**: o retry devolve a mesma 422 com o mesmo `transferId`. Sem gravar, o mesmo request daria 422 hoje e 201 amanhã. Para tentar de novo, **outra chave**.
- **Não gravam nem consomem a chave:** 400, 404, `SAME_ACCOUNT`, `INVALID_AMOUNT`, `AMOUNT_LIMIT_EXCEEDED`, `IDEMPOTENCY_KEY_REUSED` e a rejeição do depósito (`ACCOUNT_CLOSED`). O 503 normalmente não grava, mas **pode ter gravado** ([503 incerto](docs/operacao.md#503-e-resultado-incerto)).
- **Sem expiração** neste escopo (seção 8).

![Idempotência: retry sem novo débito, outro valor dá 422, 10 em paralelo gravam uma linha](docs/gifs/3-idempotencia.gif)

### Dinheiro em centavos

Inteiros de centavos: `BIGINT` no banco, `number` seguro (`Number.isSafeInteger`) no TS. A conversão fica só em `src/shared/money.ts`, que lê a representação decimal mais curta do número em vez de multiplicar o float por 100: `0.1 + 0.2` (`0.30000000000000004`) é 400, não arredondado. O parser de `BIGINT` do `pg` lança acima de 2^53. Teto por operação: R$ 1.000.000.000,00. O JSON usa `number` em reais, como no enunciado, sempre com até 2 casas; um cliente que some floats do lado dele ainda pode se confundir.

### Validação, status e erros

Erro na **forma** do pedido (schema, JSON malformado, UUID inválido, mais de 2 casas, número não finito como `1e999`, campo extra, `Idempotency-Key` ausente ou inválida, data, `limit` ou `cursor` inválidos) → **400 `VALIDATION_ERROR`**; **regra** de negócio do enunciado → **422** com o código da regra. Valor `<= 0` é 422 `INVALID_AMOUNT`; acima do teto (`1e15`, R$ 1.000.000.000,01) é 422 `AMOUNT_LIMIT_EXCEEDED`: bem formado, mas viola a regra.

- `holderName`: 1 a 120 caracteres após `trim`, ao menos uma letra, sem controle, U+FFFD ou bidi (U+202A–U+202E, U+2066–U+2069, que falsificam como o nome aparece).
- `document`: CPF ou CNPJ, 11 ou 14 dígitos puros ou na máscara canônica (`000.000.000-00`, `00.000.000/0000-00`); pontas aparadas, guardado só com dígitos, sem checar dígito verificador (o enunciado dispensa).
- Contas: `BLOCKED` recebe e não debita; `CLOSED` não movimenta e é terminal; encerra só com saldo zero, via `PATCH .../status` (sem endpoint próprio); mesmo status é 200 sem efeito; `CLOSED` segue reservando o documento (409).

Envelope único: `{ code, message, timestamp, correlationId }`, mais `details` no 400 de schema e `transferId` na 422 gravada; nunca stack trace, SQL ou mensagem do Postgres, inclusive nos erros do próprio Fastify (percent-encoding inválido, parâmetro longo, JSON malformado, corpo grande). **Lacuna conhecida:** erros do parser HTTP (cabeçalhos grandes → 431, linha malformada) não chegam ao Fastify e saem no formato cru dele; cobrir pede um `clientErrorHandler` escrevendo HTTP à mão. O `/docs` mostra os status, não os `code`:

| Status | `code` |
|---|---|
| 400 | `VALIDATION_ERROR` |
| 404 | `ACCOUNT_NOT_FOUND`, `TRANSFER_NOT_FOUND`, `ROUTE_NOT_FOUND` |
| 409 | `DOCUMENT_ALREADY_EXISTS` (inclusive em corrida) |
| 413, 415 | `PAYLOAD_TOO_LARGE` (corpo acima de 1 MB), `UNSUPPORTED_MEDIA_TYPE` (não é JSON) |
| 422 | `INVALID_AMOUNT`, `AMOUNT_LIMIT_EXCEEDED`, `SAME_ACCOUNT`, `SOURCE_ACCOUNT_NOT_ACTIVE`, `DESTINATION_ACCOUNT_CLOSED`, `INSUFFICIENT_BALANCE`, `ACCOUNT_CLOSED` (depositar numa conta encerrada ou reativá-la), `ACCOUNT_HAS_BALANCE` (encerrar com saldo), `IDEMPOTENCY_KEY_REUSED` |
| 500, 503 | `INTERNAL_ERROR`; `SERVICE_UNAVAILABLE` (só o 503 leva `Retry-After: 1`, sempre) |

### Extrato

Cada mudança de saldo é uma linha em `ledger_entries` com o `balance_after_cents` do momento e **o mesmo `created_at` da movimentação** (gravado em milissegundos, a precisão de um `Date`), então a resposta do POST, o `occurredAt` do evento e o extrato mostram o mesmo instante. A ordem é pelo `id` numérico do ledger, **não** por `created_at`: as linhas de uma conta só entram com a conta travada, então a ordem do `id` é a ordem real do saldo e bate com `balanceAfter`.

- **Cursor** (`nextCursor`): o `id` da última linha em base64url. Por `created_at` repetiria ou pularia linhas (o `timestamptz` tem microssegundos, o `Date` só milissegundos). Opaco mas **não assinado**: fabricá-lo só escolhe onde a lista recomeça, e o SQL filtra por `account_id`. Fora do formato: 400.
- **Página:** `limit` de 1 a 100 (padrão 50, só dígitos); `nextCursor` é `null` na última. `FAILED` não aparece; `BLOCKED` e `CLOSED` têm extrato.
- **Período** em UTC, `from` e `to` opcionais, `to` inclusivo até `23:59:59.999Z`, calculado no TS como instante UTC (`created_at >= $1::date` usaria o `TimeZone` da sessão).
- **Índices** (`migrations/001_init.sql`): `(account_id, id)` e `(account_id, created_at)` servem o extrato (conta, ordem por `id`, período). `transfers_source_idx` e `transfers_destination_idx` não são usados por nenhuma consulta hoje: ficariam para uma listagem por conta (seção 8) e, sem ela, sairiam em produção.

### Eventos: outbox

Transferência concluída grava, **na mesma transação**, um `TransferCompleted` em `outbox_events`: não existe transferência sem evento nem evento de transferência que não aconteceu.

```json
{ "eventId": "d682fed6-…", "eventType": "TransferCompleted", "transferId": "0f98c1b5-…",
  "sourceAccountId": "c65a080c-…", "destinationAccountId": "78e8c26b-…", "amount": 25.5,
  "occurredAt": "2026-10-30T21:26:55.090Z", "correlationId": "demo-123" }
```

Um relay no processo da API pega até 50 pendentes por rodada (`FOR UPDATE SKIP LOCKED`) e os entrega a um publicador que aqui só escreve `event published` no log; depois de 10 falhas o evento fica parado, sem backoff por evento. Entrega **at least once** (o consumidor deduplica pelo `eventId`); o `correlationId` é o da requisição que executou a transferência (replay não gera evento). O relay segura os locks e uma conexão enquanto `publish()` roda, sem timeout próprio: um publicador travado segura o lote; um broker de verdade pede esse timeout. Detalhes: [docs/operacao.md](docs/operacao.md#relay-do-outbox). Publicador real: seção 8.

## 5. Operação

Detalhe em [docs/operacao.md](docs/operacao.md). Resumo:

- **Logs** JSON (pino), com `correlationId` em toda linha de requisição e linhas de negócio (`account created`, `deposit processed`, `transfer processed`, `event published`...). Nunca documento, nome, corpo nem o `detail` do `pg`.
- **Rastreio:** `docker compose logs api | grep <correlationId>` ou `grep <transferId>`; no banco, `transfers` → `ledger_entries` → `outbox_events`.
- **`/health`** é liveness (não toca o banco); **`/ready`** é readiness (`SELECT 1`, 503 se o banco não responde).
- **Nada espera para sempre:** pool 5 s, `lock_timeout` 5 s, `statement_timeout` 15 s, `query_timeout` 20 s, tudo virando 503 + `Retry-After: 1`. Conexão que cai não derruba o processo, e o `SIGTERM` espera as requisições em andamento antes de sair.
- **Um 503 pode ter gravado:** reenvie com a **mesma** `Idempotency-Key`.

## 6. Escala: 10x e 100x

Detalhe em [docs/escala-e-provedor.md](docs/escala-e-provedor.md). Resumo:

- Quebra primeiro na **conta quente**: o lock serializa as transferências da mesma conta, e cada requisição esperando segura uma conexão; com as 10 do pool ocupadas, outras contas e o `/ready` também caem em 503 (pelo timeout do pool, antes do `lock_timeout`).
- Ordem de grandeza, medida uma vez num host compartilhado e sem script versionado: na casa de mil transferências/s com muitas contas e algumas centenas por segundo numa conta quente.
- Primeira mitigação em produção: `lock_timeout` abaixo do timeout do pool, para a conta quente falhar rápido sem segurar o pool; depois, fila por conta.
- Extrato de uma conta enorme percorre a PK; `ORDER BY account_id, id` dá o mesmo plano. A correção é uma sequência por conta ou partição.
- 10x: PgBouncer, réplica de leitura, relay como worker. 100x: fila por conta, shard por conta ou sub-contas, ledger particionado por mês.

## 7. Provedor externo (desafio adicional, só documento)

Nada implementado; desenho com diagrama em [docs/escala-e-provedor.md](docs/escala-e-provedor.md#provedor-externo-desafio-adicional). A transferência externa nasce `PENDING` com o valor reservado e o evento no outbox (202); um worker chama o provedor com timeout curto, repassando a `Idempotency-Key`. Timeout vira `UNKNOWN`, nunca `FAILED`. Retry só em timeout, 5xx e 429, com backoff exponencial e jitter, e DLQ ao esgotar; circuit breaker na frente; reconciliação diária corrige com lançamentos novos no ledger.

## 8. Fora do escopo e pendências

O enunciado pede uma API pequena e correta, e saber o que não construir faz parte:

| Item | Como faria | Risco hoje |
|---|---|---|
| Autenticação, rate limiting e headers de hardening (API e `/docs` abertos) | JWT ou mTLS no gateway; rate limit por conta e IP; `helmet` ou o gateway (HSTS, `X-Content-Type-Options`), CORS explícito | qualquer um que alcance a API movimenta dinheiro, e as respostas não têm os headers de proteção; por isso o compose só a publica em 127.0.0.1 |
| Credenciais padrão e superusuário no compose | segredos fora do compose; role da aplicação sem superusuário nem DDL, migration com outro role | só desenvolvimento local: `banking`/`banking`, API como superusuário |
| Idempotência: escopo global, sem expiração | escopo `(cliente, chave)` com autenticação; TTL (24 h a 7 dias, a decidir com os clientes) e job de limpeza, que também apaga `outbox_events` publicados | um cliente que reaproveite a chave de outro recebe o replay alheio; tabelas e índice `UNIQUE` crescem sem fim |
| Relay sem backoff por evento | `next_attempt_at` com backoff exponencial, ou retry e DLQ do SQS | com intervalo de 1 s, uma queda do broker de ~10 s esgota as 10 tentativas e estaciona os eventos até alguém zerar `attempts` ([operação](docs/operacao.md#relay-do-outbox)) |
| Broker real (SNS/SQS ou Kafka) | publicador de verdade no relay, consumidor idempotente | os eventos só aparecem no log |
| CPF/CNPJ sem dígito verificador; CNPJ alfanumérico | checksum em `rules.ts` e o formato alfanumérico | documento inválido entra; CNPJ alfanumérico recebe 400 |
| Documento em claro no banco e na resposta | criptografar em repouso, mascarar na resposta | exposição de dado pessoal se o banco vazar |
| Métricas e tracing | Prometheus (latência, 503, fila do outbox) e OpenTelemetry | só dá para investigar por log |
| Teste de carga versionado | k6 contra uma conta quente e contra muitas contas, em ambiente dedicado | os números da seção 6 foram medidos uma vez durante o desenvolvimento, antes da rodada final de correções, num host compartilhado, sem script no repositório |
| Saldo acima de ~R$ 70 trilhões | `BIGINT` como `bigint`/string decimal de ponta a ponta | a resposta usa `centavos / 100` em `number`: acima de 2^46 reais o JSON pode perder um centavo na exibição; em 2^53 centavos (~R$ 90 trilhões, ~90 mil depósitos do teto) o parser do `pg` lança, a operação dá rollback e responde 500 (falha fechada) |
| Redis, multimoeda, listagem de contas e transferências (e busca por documento), endpoint de encerramento (é um `PATCH`), provedor externo (seção 7) | não construídos de propósito | nenhum para o enunciado |
