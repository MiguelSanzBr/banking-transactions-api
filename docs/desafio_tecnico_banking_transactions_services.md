# 🏦 Desafio Técnico Backend — Banking Transactions & Services

## Cenário

Você fará parte de um time responsável por produtos e serviços financeiros que processam operações bancárias em larga escala.

Nesse contexto, alguns dos principais desafios de engenharia envolvem:

* garantir a consistência de movimentações financeiras;
* impedir duplicidade de transações;
* evitar saldo negativo mesmo em cenários concorrentes;
* lidar adequadamente com falhas;
* construir APIs que possam evoluir sem comprometer seus consumidores;
* permitir rastreabilidade e investigação de problemas;
* manter código simples, testável e sustentável.

Sua missão será construir uma pequena **API de Banking Transactions**, responsável pelo gerenciamento de contas e pelo processamento de movimentações financeiras.

O objetivo não é reproduzir um Core Banking completo.

Queremos entender **como você pensa e toma decisões de engenharia diante de problemas comuns em sistemas financeiros**.

---

# 🎯 O desafio

Implemente uma API REST que permita:

1. criar contas;
2. consultar uma conta;
3. bloquear e desbloquear uma conta;
4. realizar depósitos;
5. realizar transferências entre contas;
6. consultar transferências;
7. consultar o extrato de uma conta.

Além do funcionamento básico, algumas regras de consistência e processamento devem ser respeitadas.

---

# 🧱 1. Contas

Uma conta deve possuir pelo menos:

```json
{
  "id": "uuid",
  "holderName": "João da Silva",
  "document": "12345678900",
  "status": "ACTIVE",
  "balance": 1500.00,
  "createdAt": "2026-09-09T14:30:00Z"
}
```

Estados possíveis:

```text
ACTIVE
BLOCKED
CLOSED
```

## Criar conta

```http
POST /accounts
```

Exemplo:

```json
{
  "holderName": "João da Silva",
  "document": "12345678900"
}
```

### Regras

* uma conta deve iniciar com saldo `0`;
* o documento deve ser único;
* uma conta criada deve iniciar como `ACTIVE`;
* valores monetários não devem sofrer problemas de precisão de ponto flutuante.

A validação formal de CPF **não é obrigatória**.

---

## Consultar conta

```http
GET /accounts/{accountId}
```

A resposta deve permitir consultar pelo menos:

* identificador;
* titular;
* status;
* saldo;
* data de criação.

---

# 🔐 2. Bloqueio de conta

Deve ser possível bloquear e desbloquear uma conta.

Exemplo:

```http
PATCH /accounts/{accountId}/status
```

```json
{
  "status": "BLOCKED"
}
```

Uma conta bloqueada:

* pode receber créditos;
* não pode realizar operações de débito.

Uma conta encerrada não pode realizar novas movimentações.

---

# 💰 3. Depósito

```http
POST /accounts/{accountId}/deposits
```

Exemplo:

```json
{
  "amount": 500.00
}
```

### Regras

* o valor deve ser maior que zero;
* contas encerradas não podem receber depósitos;
* a operação deve aparecer posteriormente no extrato.

---

# 💸 4. Transferências

Este é o principal fluxo do desafio.

```http
POST /transfers
```

Exemplo:

```json
{
  "sourceAccountId": "uuid-1",
  "destinationAccountId": "uuid-2",
  "amount": 250.00
}
```

A requisição deve possuir também:

```http
Idempotency-Key: 98b41676-5845-4327-9afa-641f02147691
```

A resposta poderá seguir um contrato semelhante a:

```json
{
  "id": "transfer-uuid",
  "sourceAccountId": "uuid-1",
  "destinationAccountId": "uuid-2",
  "amount": 250.00,
  "status": "COMPLETED",
  "createdAt": "2026-09-09T14:40:00Z"
}
```

Você pode evoluir esse contrato caso considere necessário.

---

# 📋 5. Regras da transferência

Uma transferência somente poderá ser executada quando:

* as duas contas existirem;
* a conta de origem estiver `ACTIVE`;
* a conta destino não estiver `CLOSED`;
* o valor for maior que zero;
* houver saldo suficiente;
* origem e destino forem contas diferentes.

Uma conta **nunca poderá possuir saldo negativo**.

---

# 🔁 6. Idempotência

APIs financeiras precisam lidar com retries.

Imagine o seguinte cenário:

```text
Cliente
   |
   | POST /transfers
   v
API
   |
   | transferência executada
   v
Banco de Dados

--- timeout na resposta ---

Cliente não sabe se funcionou
   |
   | retry
   v
POST /transfers
```

Sem proteção, o cliente poderia ser debitado duas vezes.

Por isso, `POST /transfers` deve aceitar:

```http
Idempotency-Key
```

Duas requisições equivalentes com a mesma chave devem resultar em **uma única movimentação financeira**.

Exemplo:

```text
POST /transfers
Idempotency-Key: abc123

R$ 100 transferidos
```

Retry:

```text
POST /transfers
Idempotency-Key: abc123
```

Resultado:

```text
A transferência anterior é retornada.
Nenhum novo débito é realizado.
```

Você deverá definir o comportamento para o caso de uma mesma `Idempotency-Key` ser reutilizada com um payload diferente e documentar sua decisão.

---

# ⚡ 7. Concorrência

Considere uma conta com:

```text
Saldo: R$ 100
```

Duas requisições chegam praticamente ao mesmo tempo:

```text
Transferência A → R$ 80
Transferência B → R$ 80
```

O sistema **não poderá finalizar as duas transferências**.

Ao término do processamento:

```text
saldo >= 0
```

deve sempre ser verdade.

A estratégia utilizada para garantir essa consistência fica a seu critério.

Queremos entender sua decisão.

Algumas possibilidades existentes são:

* transações de banco de dados;
* optimistic locking;
* pessimistic locking;
* operações atômicas;
* serialização de comandos;
* outra estratégia que considere adequada.

Não existe uma solução obrigatória.

---

# 📊 8. Extrato

Implemente:

```http
GET /accounts/{accountId}/statement
```

Deve ser possível consultar as movimentações da conta.

Exemplo de resposta:

```json
{
  "accountId": "uuid",
  "items": [
    {
      "type": "DEPOSIT",
      "amount": 500.00,
      "createdAt": "2026-09-09T10:00:00Z"
    },
    {
      "type": "TRANSFER_OUT",
      "amount": 100.00,
      "createdAt": "2026-09-09T11:00:00Z"
    },
    {
      "type": "TRANSFER_IN",
      "amount": 75.00,
      "createdAt": "2026-09-09T12:00:00Z"
    }
  ]
}
```

A consulta deve aceitar um período:

```http
GET /accounts/{accountId}/statement?from=2026-09-01&to=2026-09-30
```

Paginação será considerada um diferencial.

---

# 🔎 9. Consulta de transferência

Implemente:

```http
GET /transfers/{transferId}
```

Essa operação deve permitir consultar o resultado de uma transferência anteriormente processada.

---

# ❌ 10. Tratamento de erros

A API deve utilizar corretamente os status HTTP.

Esperamos tratamento para situações como:

```text
400 - requisição inválida
404 - recurso não encontrado
409 - conflito
422 - regra de negócio não atendida
500 - erro interno
```

O formato dos erros fica a seu critério, desde que seja consistente.

Exemplo:

```json
{
  "code": "INSUFFICIENT_BALANCE",
  "message": "The source account does not have enough balance.",
  "timestamp": "2026-09-09T15:00:00Z"
}
```

Evite expor stack traces ou detalhes internos da aplicação ao consumidor da API.

---

# 🤖 Uso de Inteligência Artificial

## Sim. Queremos que você utilize IA.

Ferramentas de IA fazem parte da realidade moderna de desenvolvimento de software.

Você está livre — e é **incentivado** — a utilizar ferramentas como:

* ChatGPT;
* GitHub Copilot;
* Claude;
* Gemini;
* Cursor;
* Codex;
* ferramentas de geração de testes;
* agentes de desenvolvimento;
* outras ferramentas que façam parte do seu workflow.

**O uso de IA não será considerado trapaça.**

Não queremos avaliar sua capacidade de digitar código que uma ferramenta consegue gerar.

Queremos avaliar sua capacidade de:

> **utilizar ferramentas modernas para construir software correto, compreensível e sustentável.**

Entretanto, todo código entregue é de sua responsabilidade.

Durante a entrevista técnica poderemos perguntar:

* por que determinada implementação foi escolhida;
* quais alternativas foram consideradas;
* como determinada regra funciona;
* quais problemas poderiam acontecer em produção;
* que código foi gerado ou auxiliado por IA;
* o que você alteraria na solução caso tivesse mais tempo.

Você deve conseguir explicar e defender sua solução.

---

# 🧠 AI Engineering Notes

Crie no projeto:

```text
AI_USAGE.md
```

Não esperamos um histórico completo de conversas ou prompts.

O documento deve explicar resumidamente:

### Ferramentas utilizadas

Exemplo:

```text
GitHub Copilot
ChatGPT
Claude
```

### Onde a IA ajudou

Exemplo:

```text
- geração inicial dos testes;
- discussão da estratégia de idempotência;
- geração do Dockerfile;
- revisão de possíveis race conditions;
- refatoração de determinadas classes.
```

### Pelo menos um exemplo de interação relevante

Pode ser:

```text
Problema:
Precisava garantir que duas transferências concorrentes
não deixassem a conta negativa.

Utilizei IA para:
Explorar estratégias de optimistic e pessimistic locking.

Decisão final:
Escolhi optimistic locking porque...
```

### Validação crítica

Descreva pelo menos uma situação em que:

* a IA sugeriu algo inadequado;
* você encontrou um problema na solução gerada;
* ou decidiu implementar algo diferente da sugestão recebida.

Essa parte será particularmente interessante para nossa conversa técnica.

---

# 🧪 Testes

Esperamos testes automatizados.

Você decide a distribuição entre:

* testes unitários;
* testes de integração;
* testes de API;
* testes de contrato;
* outros.

Entretanto, recomendamos atenção especial para os seguintes cenários:

### Saldo insuficiente

```text
saldo: R$ 100
transferência: R$ 150

Resultado:
transferência rejeitada
saldo: R$ 100
```

### Retry

```text
Transferência R$ 100
Idempotency-Key: abc

Retry
Idempotency-Key: abc

Resultado:
apenas R$ 100 debitados
```

### Concorrência

```text
saldo: R$ 100

Transfer A: R$ 80
Transfer B: R$ 80

Resultado esperado:
somente uma poderá ser concluída.
```

Não esperamos necessariamente exatamente esses três testes. Queremos observar sua estratégia de qualidade.

---

# 🗄️ Persistência

Utilize uma solução de persistência real.

Exemplos:

* PostgreSQL;
* MySQL;
* MongoDB;
* DynamoDB;
* outra tecnologia que considere adequada.

Não há preferência por tecnologia.

A escolha deve ser coerente com o problema.

Banco de dados exclusivamente em memória poderá ser utilizado para testes, mas não deverá ser a única estratégia de persistência da aplicação.

---

# 🛠️ Tecnologias

Você poderá utilizar a linguagem e framework com os quais possuir maior domínio.

Exemplos:

* Java;
* Kotlin;
* Go;
* Python;
* TypeScript / Node.js;
* C#;
* outras tecnologias de backend.

A escolha tecnológica **não faz parte da avaliação de senioridade**.

Preferimos uma boa solução na tecnologia que você domina a uma solução excessivamente complexa utilizando tecnologias escolhidas apenas para impressionar.

---

# 🏗️ Arquitetura

Você possui liberdade para organizar a solução.

Podem ser utilizados conceitos como:

* Clean Architecture;
* Hexagonal Architecture;
* DDD;
* Onion Architecture;
* MVC;
* Transaction Script;
* modular monolith;
* outras abordagens.

Nenhum padrão arquitetural específico é obrigatório.

> **Complexidade arquitetural sem necessidade não será considerada um diferencial.**

Esperamos principalmente:

* separação clara de responsabilidades;
* código fácil de compreender;
* regras de negócio testáveis;
* dependências bem definidas;
* decisões coerentes com o tamanho do problema.

---

# 📚 Documentação

O `README.md` da sua solução deve explicar:

### Como executar

```bash
docker compose up
```

ou os comandos equivalentes da tecnologia escolhida.

### Como executar os testes

Exemplo:

```bash
make test
```

### Como consumir a API

Pode ser utilizado:

* Swagger / OpenAPI;
* Postman;
* Insomnia;
* exemplos com `curl`;
* outra abordagem.

### Decisões arquiteturais

Explique brevemente:

* estrutura da aplicação;
* estratégia utilizada para transações;
* estratégia utilizada para concorrência;
* implementação da idempotência;
* principais trade-offs.

Não é necessário produzir um documento arquitetural extenso.

---

# 📦 Docker

A aplicação deverá possuir uma forma simples e reproduzível de execução local.

Preferencialmente:

```bash
docker compose up
```

Subindo:

```text
API
+
Banco de dados
```

com o mínimo possível de configuração manual.

---

# 🌟 Diferenciais

Os itens abaixo **não são obrigatórios**.

Eles existem para permitir que você demonstre conhecimentos adicionais caso considere relevante.

Não esperamos que todos sejam implementados.

## Observabilidade

Por exemplo:

* logs estruturados;
* correlation ID;
* métricas;
* health checks;
* tracing;
* logs que permitam rastrear uma transação.

---

## OpenAPI

Documentação utilizando:

```text
Swagger / OpenAPI
```

---

## CI

Pipeline contendo etapas como:

```text
build
test
lint
```

---

## Segurança

Exemplos:

* validação adequada de input;
* proteção contra exposição de informações internas;
* gerenciamento adequado de secrets;
* autenticação simples;
* rate limiting.

Autenticação completa **não é necessária para o desafio**.

---

## Eventos

Você pode considerar que uma transferência concluída poderia produzir algo como:

```json
{
  "eventType": "TransferCompleted",
  "transferId": "uuid",
  "occurredAt": "2026-09-09T14:30:00Z"
}
```

Não é necessário instalar Kafka.

Caso queira demonstrar conhecimento sobre arquitetura orientada a eventos, poderá implementar ou documentar estratégias como:

* Outbox Pattern;
* fila;
* broker;
* EventBridge;
* Kafka;
* SNS/SQS;
* outra alternativa.

---

# 🚀 Desafio adicional — processamento externo

Caso queira explorar um problema adicional, considere que algumas transações podem depender de um **provedor financeiro externo**.

Esse provedor poderá:

```text
responder normalmente
demorar para responder
retornar erro
ficar temporariamente indisponível
```

Explique como sua arquitetura lidaria com situações como:

```text
timeout
retry
duplicate request
circuit breaker
processamento assíncrono
reconciliação
```

Você pode:

* implementar;
* criar testes;
* produzir um pequeno diagrama;
* ou apenas documentar sua estratégia.

Não existe necessidade de construir um segundo serviço.

---

# ⏱️ Escopo e tempo

Não queremos transformar o desafio em um projeto de várias semanas.

Recomendamos um investimento de aproximadamente:

```text
6 a 8 horas
```

Caso não consiga implementar algo dentro desse período, documente:

```text
- o que ficou pendente;
- como você implementaria;
- quais seriam os principais riscos;
- que decisão tomaria em um ambiente de produção.
```

Um bom trade-off documentado pode nos dizer mais sobre sua experiência do que dezenas de funcionalidades adicionais.

---

# 🔬 O que vamos avaliar

Nossa avaliação não será baseada simplesmente na quantidade de funcionalidades implementadas.

Consideraremos principalmente:

### 1. Correção e regras de negócio

* implementação correta das operações;
* tratamento dos cenários de erro;
* consistência dos dados.

### 2. Engenharia de transações

* atomicidade;
* idempotência;
* concorrência;
* consistência de saldo.

### 3. Design da solução

* organização;
* separação de responsabilidades;
* legibilidade;
* simplicidade;
* capacidade de evolução.

### 4. Qualidade

* testes;
* testabilidade;
* tratamento de edge cases;
* qualidade geral do código.

### 5. Pensamento operacional

* logs;
* rastreabilidade;
* comportamento diante de falhas;
* preocupações com produção.

### 6. Uso de IA

Não avaliaremos quem criou mais código utilizando IA.

Avaliaremos:

* como a ferramenta foi utilizada;
* capacidade de revisar código gerado;
* capacidade de detectar soluções inadequadas;
* capacidade de explicar o código entregue;
* capacidade de utilizar IA como ferramenta de engenharia e não apenas como geradora de código.

### 7. Comunicação técnica

Durante a revisão queremos entender:

```text
Por que você fez dessa maneira?

Quais alternativas considerou?

O que aconteceria com 10x ou 100x mais volume?

Onde essa solução poderia falhar?

O que mudaria em produção?
```

---

# 👨‍💻 O que esperamos de diferentes níveis

A classificação não será determinada pela implementação de um item específico.

## Engenharia de Software — Pleno

Normalmente esperamos encontrar:

* aplicação funcional;
* API consistente;
* boa organização de código;
* persistência adequada;
* testes relevantes;
* tratamento de erros;
* transações corretamente implementadas;
* idempotência;
* entendimento dos principais cenários concorrentes;
* capacidade de explicar suas escolhas.

---

## Engenharia de Software — Sênior

Além dos pontos anteriores, buscamos sinais como:

* análise mais profunda de concorrência;
* clareza nos limites transacionais;
* compreensão de failure modes;
* decisões arquiteturais baseadas em trade-offs;
* preocupações de observabilidade e operação;
* desenho preparado para evolução;
* boa estratégia de testes;
* entendimento de sistemas distribuídos;
* visão crítica sobre código gerado por IA.

Não é necessário adicionar Kubernetes, Kafka ou dezenas de abstrações para demonstrar senioridade.

**Senioridade também aparece na capacidade de saber o que não precisa ser construído.**

---

# 📏 Critérios de avaliação

Como referência, a avaliação poderá considerar:

| Área                                      | Peso |
| ----------------------------------------- | ---: |
| Regras de negócio e funcionamento         |  20% |
| Consistência, concorrência e idempotência |  20% |
| Design e qualidade de código              |  15% |
| Testes e qualidade                        |  15% |
| Decisões arquiteturais e trade-offs       |  10% |
| Pensamento operacional                    |  10% |
| Uso crítico de IA                         |   5% |
| Documentação e comunicação                |   5% |

Os pesos servem apenas como orientação e poderão ser complementados pela entrevista técnica.

---

# ⚠️ Importante

Não existe uma arquitetura "correta" esperada previamente.

Durante a avaliação, uma solução simples e bem fundamentada poderá ser considerada superior a uma solução sofisticada desnecessariamente.

O objetivo deste desafio é gerar material para uma boa conversa de engenharia.

Queremos observar não apenas:

> **"Você conseguiu fazer?"**

mas principalmente:

> **"Como você pensou para resolver?"**

---

# 📤 Entrega

1. Crie um repositório privado no GitHub;
2. Desenvolva sua solução;
3. Mantenha um histórico de commits que permita entender minimamente a evolução do trabalho;
4. Inclua toda documentação necessária para execução;
5. Inclua o arquivo `AI_USAGE.md`;
6. Adicione como colaboradores os usuários informados pelo time de recrutamento;
7. Envie o link do repositório para a pessoa responsável pelo processo seletivo.

---

# 💬 Revisão técnica

Caso avance para a próxima etapa, utilizaremos sua própria implementação como base para uma conversa técnica.

Não será uma prova de memorização.

Queremos conversar sobre coisas como:

* sua arquitetura;
* seus testes;
* decisões tomadas;
* problemas encontrados;
* uso de IA;
* concorrência;
* idempotência;
* possíveis incidentes;
* escalabilidade;
* como essa solução evoluiria em produção.

Boa sorte! 🚀
